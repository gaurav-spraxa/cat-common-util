import fse from 'fs-extra';
import path from 'path';
import machineIdSync from 'node-machine-id';
import nodeRSA from 'node-rsa';
import dayjs from 'dayjs';
import isBetween from 'dayjs/plugin/isBetween.js';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js';
dayjs.extend(isSameOrBefore)
dayjs.extend(isBetween);

const currentCatVersion = '62597d8fec95ff1d50fecac5';
const catViewerPath = '';

let licenseData = {};
let equipmentData = {};
let licenseInfo = {};
let clientId = null;

const identifyPath = function (paths) {
    for (const { path: filePath, file } of paths) {
        if (filePath && fse.existsSync(path.join(filePath, file))) {
            return path.join(filePath, file);
        }
    }
}
const isValidLicense = function () {
    return licenseInfo;
}

const updateClientId = async function (mongoose, oldClientId = null) {
    const client = await mongoose.models['security.client'].findOne({ LicenseClientId: licenseData.ClientId }).lean().exec();
    if (client) {
        clientId = client._id;
        oldClientId = clientId;
        return oldClientId;
    }
    return null;
}
const getClientId = async function (mongoose) {
    if (clientId) {
        return clientId;
    }
    else {
        const client = await mongoose.models['security.client'].findOne({ LicenseClientId: licenseData.ClientId }).lean().exec();
        if (client) {
            clientId = client._id;
            return clientId;
        }
    }
    return null;
}

const updateIsLicenseUpdated = () => {
    licenseInfo.IsLicenseUpdated = false
}

/**
 * @param {string} isLicenseUpdated - Used When updating license
 */
const initCATLicense = async function (isLicenseUpdated, logger) {
    let machineId = `${machineIdSync.machineIdSync({ original: true })}`;
    const licenseLocation = catViewerPath ? path.join(catViewerPath, 'web') : process.cwd();
    const licenseFile = identifyPath([
        { path: licenseLocation, file: 'license.lic' }
    ]);
    const publicKeyPath = identifyPath([
        { path: licenseLocation, file: 'public.pem' },
        { path: licenseLocation, file: 'catpublickey.pem' }
    ]);
    const machineKeyPath = identifyPath([
        { path: licenseLocation, file: 'MachineKey.json' }
    ]);
    try {
        if (!machineKeyPath) {
            await fse.writeFile(path.join(licenseLocation, 'MachineKey.json'), JSON.stringify({ MachineId: machineId }));
        }
        if (!licenseFile) {
            logger.error(`${machineId}: License file not found at ${licenseLocation}`);
            licenseInfo = {
                LicenseValid: false,
                MachineKey: machineId
            };
            return licenseInfo;
        }
        if (!publicKeyPath) {
            logger.error(`${machineId}: Public key not found at ${publicKeyPath}`);
            licenseInfo = {
                LicenseValid: false,
                MachineKey: machineId
            };
            return licenseInfo;
        }

        const publicKeyContent = await fse.readFile(publicKeyPath, 'utf8');
        const licenseContent = await fse.readFile(licenseFile, 'utf8');
        const key = new nodeRSA(publicKeyContent);
        licenseData = JSON.parse(key.decryptPublic(licenseContent, 'utf8'));
        equipmentData = JSON.parse(key.decryptPublic(licenseContent, 'utf8')).items || [];
        const vaildVersion = isVersionMismatch({ licContent: licenseData, publicKeyContent, machineId });
        licenseData.serialNumbers = (licenseData.EquipmentSerial || licenseData.serialNumbers).split(',');

        let appName = ['catviewer'];
        let isOldCATViewer = false;
        if (licenseData.AppName === undefined) {
            appName = (licenseData.EquipmentSerial === undefined) ? ["catexport"] : ["catviewer"];
            isOldCATViewer = true;
        } else {
            appName = Array.isArray(licenseData.AppName) ? licenseData.AppName : [licenseData.AppName];
        }
        if (isOldCATViewer) {
            logger.warn(`License file is old please update with new license file`);
            licenseInfo = {
                LicenseValid: false,
                MachineKey: machineId
            }
            return licenseInfo;
        }
        appName = appName.map(element => element.toLowerCase());
        let isSameClientId = true;
        if (isLicenseUpdated) {
            isSameClientId = licenseData.ClientId === licenseInfo.ClientId
        }
        licenseInfo = {
            LicenseValid: !vaildVersion ? vaildVersion : (licenseData.MachineKey === machineId || licenseData.machineId === machineId),
            MachineKey: machineId,
            HospitalName: licenseData.HospitalName,
            HospitalLogo: licenseData?.HospitalLogo || licenseData?.hospitalLogo,
            SyncSchedule: licenseData.SyncSchedule,
            DefaultLanguage: licenseData.DefaultLanguage,
            EquipmentSerial: licenseData.serialNumbers,
            ClientId: licenseData.ClientId || licenseData.clientId,
            AppName: appName,
            gracePeriod: licenseData.gracePeriod || 90, //by default grace period will be 90
            hardStop: licenseData.hardStop || 90, // by default hard stop will be 90
            equipmentData: equipmentData,
            CatViewerVersion: licenseData.CatViewerVersion || "0.0.0",
            CatSyncVersion: licenseData.CatSyncVersion || "0.0.0",
            IsLicenseUpdated: isLicenseUpdated || false,
            isSameClientId,
            isCatEdge: /catedge/i.test(licenseData.AppName),
            expirationDate: licenseData.ExpirationDate,
            Country: licenseData.Country,
            State: licenseData.State,
            Locality: licenseData.Locality,
            Organization: licenseData.Organization,
            OrganizationalUnit: licenseData.OrganizationalUnit,
            CommonName: licenseData.CommonName,
            EmailAddress: licenseData.EmailAddress,
            // #102359 - Update/Add Usertypes and menu access to match security Role Document
            //  Adding password from the license
            SuperAdminPassword: licenseData?.Password,
            TimeZone: licenseData?.TimeZone
        }
        return licenseInfo;
    } catch (err) {
        logger.error({ err }, `Error while decrypting the license:`);
        licenseInfo = {
            LicenseValid: false,
            MachineKey: machineId
        }
        return licenseInfo;
    }
}

const isValidSerialNumber = function (serialNumber) {
    return licenseData.serialNumbers?.includes(serialNumber);
}

const setZeroInTime = (time) => {
    return time.set('hour', 0).set('minute', 0).set('second', 0).set('millisecond', 0)
}

// check license expired or not
const isLicenseExpired = () => {
    return !setZeroInTime(dayjs()).isSameOrBefore(dayjs(licenseInfo.expirationDate));
}

// Grace Period Expiry Date
const gracePeriodExpOn = () => {
    return dayjs(licenseData.ExpirationDate).add(licenseInfo.gracePeriod, "days");
}

// check license grace period over or not
const isGracePeriodOver = () => {
    return !setZeroInTime(dayjs()).isSameOrBefore(gracePeriodExpOn());
}

// check license is in grace period
const isInGracePeriod = () => {
    return isLicenseExpired() && !isGracePeriodOver();
}

// Hard Stop Period Expiry Date
const hardStopExpOn = () => {
    return dayjs(licenseData.ExpirationDate).add(licenseInfo.gracePeriod + licenseInfo.hardStop, "days");
}

// check license hard stop period over or not
const isHardStopPeriodOver = () => {
    return !setZeroInTime(dayjs()).isSameOrBefore(hardStopExpOn());
}

// check license is in hard stop period
const isInHardStopPeriod = () => {
    return isLicenseExpired() && isGracePeriodOver() && !isHardStopPeriodOver()
}

const licenseExpInfo = () => {
    return {
        isLicenseExpired: isLicenseExpired(),
        isInGracePeriod: isInGracePeriod(),
        gracePeriodExpOn: gracePeriodExpOn(),
        hardStopExpOn: hardStopExpOn(),
        isInHardStopPeriod: isInHardStopPeriod(),
        isGracePeriodOver: isGracePeriodOver(),
        isHardStopPeriodOver: isHardStopPeriodOver(),
    }
}

const isVersionMismatch = function ({ licContent, machineId }) {
    const validMachinId = licContent.MachineKey === machineId;
    if (licContent?.CatVersion && currentCatVersion !== licContent.CatVersion || !validMachinId || !Object.prototype.hasOwnProperty.call(licContent, 'CatVersion')) {
        return false;
    }
    return true;
}

export {
    isValidLicense,
    isValidSerialNumber,
    isHardStopPeriodOver,
    isInHardStopPeriod,
    initCATLicense,
    getClientId,
    updateClientId,
    updateIsLicenseUpdated,
    isLicenseExpired,
    isGracePeriodOver,
    isInGracePeriod,
    licenseExpInfo,
    isVersionMismatch
};

