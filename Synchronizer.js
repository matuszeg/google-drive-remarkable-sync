// 50MB = 50 * 1024*1024 = 52428800
// (apparently a ReMarkable limitation)
const rMbUploadLimit = 52428800;
const rCacheFname = 'RmCache.json';

const rDeviceTokenKey = "__REMARKABLE_DEVICE_TOKEN__";
const rDeviceIdKey = "__REMARKABLE_DEVICE_ID__";
const availableModes = ["mirror", "update", "2way", "2way-full"];

// https://stackoverflow.com/questions/23013573/swap-key-with-value-json/54207992#54207992
const reverseDict = (o, r = {}) => Object.keys(o).map(x => r[o[x]] = x) && r;

// https://github.com/30-seconds/30-seconds-of-code/blob/master/snippets/chunk.md
const chunk = (arr, size) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );

// emulate python's pop
const dictPop = (obj, key, def) => {
  if (key in obj) {
    let val = obj[key];
    delete obj[key];
    return val;
  } else if (def !== undefined) {
    return def;
  } else {
    throw `key ${key} not in dictionary`
  }
}

// https://stackoverflow.com/questions/7905929/how-to-test-valid-uuid-guid
const isUUID = (uuid) => {
  let re = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  return re.test(uuid)
}

// Update blob (Blob) or create in parentFolder (GDFolder)
function _updateOrCreate(parentFolder, blob) {
  let identicalNameFiles = parentFolder.searchFiles(
    `title = '${blob.getName()}'`);
  let currentFile;
  if (identicalNameFiles.hasNext()) {
    currentFile = identicalNameFiles.next();
    Drive.Files.update({
      title: currentFile.getName(),
      mimeType: currentFile.getMimeType()
    }, currentFile.getId(), blob);
  } else {
    currentFile = DriveApp.createFile(blob);
    currentFile.moveTo(parentFolder);
  }
  return currentFile;
}

function _ensureFile(fname, folder) {
  let iter = folder.getFilesByName(fname);
  if (iter.hasNext()) {
    return iter.next();
  } else {
    return DriveApp
      .createFile(fname, JSON.stringify([]))
      .moveTo(folder);
  }
}

function _listToIdDict(cacheList) {
  let cache = {};
  for (var doc of cacheList) {
    cache[doc.ID] = doc;
  }
  return cache;
}

class Cache {
  constructor(srcFname, folder) {
    this.folder = folder;
    this.file = _ensureFile(srcFname, folder);
    let cacheList = JSON.parse(this.file.getBlob().getDataAsString());
    this.cache = _listToIdDict(cacheList);
  }
  save(rDocList) {
    let cacheBlob = Utilities.newBlob(JSON.stringify(rDocList));
    this.file = Drive.Files.update({
      title: this.file.getName(),
      mimeType: this.file.getMimeType()
    }, this.file.getId(), cacheBlob);
    this.cache = _listToIdDict(rDocList);
    return this.file;
  }
}

/*  Main work here. Walks Google Drive then uploads
 folder and files to Remarkable cloud storage. Currently
 only uploads PDFs. There appears to be a limitation
 with Remarkable that files must be less than 50MB so
 files greater than this size are filtered out.

Arguments:

rOneTimeCode - One time pass code from Remarkable that can typically
               be generated at https://my.remarkable.com/connect/mobile.
gdFolderSearchParams - Google Drive search SDK string or folder id.
rRootFolderName - The root folder in Remarkable device. Currently this
                  must already exist on your device. This can be a remarkable
                  folder GUID if you know it.
syncMode - "mirror" or "update" (default). Mirroring will delete files
           in Remarkebale cloud that have been removed from Google Drive.
gdFolderSkipList - Optional list of folder names to skip from syncing
forceUpdateFunc - Optional function of obj dictionaries, the first generated
                  from Google Drive, the second from Remarkable storage. The
                  function returns true/false and determines whether you
                  wish to bump up the version and force push.
formats - Optional list of all the file type formats to look for and upload
          defaults to just pdf, but epub has also been tested and works on device

*/
class Synchronizer {
  constructor(rOneTimeCode, gdFolderSearchParams, rRootFolderName, syncMode = "update", gdFolderSkipList = [], forceUpdateFunc = null, formats = [pdf]) {

    // try finding google folder by id first
    try {
      this.gdFolder = DriveApp.getFolderById(gdFolderSearchParams);
    } catch (err) {
      let gdSearchFolders = DriveApp.searchFolders(gdFolderSearchParams);
      if (gdSearchFolders.hasNext()) {
        this.gdFolder = gdSearchFolders.next();
      } else {
        throw `Could not find Google Drive folder using search params: ${gdFolderSearchParams}`;
      }
    }

    this.cacheInfo = new Cache(rCacheFname, this.gdFolder);
    this.gdFolderSkipList = gdFolderSkipList;
	this.formats = formats;
    this.forceUpdateFunc = forceUpdateFunc || ((r, s) => false);
    // we borrow terminology from https://freefilesync.org/manual.php?topic=synchronization-settings
    if (!availableModes.includes(syncMode)) {
      throw `syncMode '${syncMode}' not supported, try one from: ${availableModes}`
    }
    this.syncMode = syncMode;

    // for limits see https://developers.google.com/apps-script/guides/services/quotas
    this.userProps = PropertiesService.getUserProperties();

    // these are read from and cached to this.userProps
    this.gdIdToUUID = this.userProps.getProperties();

    // pop off keys not used for storing id/uuid mappings
    let rDeviceToken = dictPop(this.gdIdToUUID, rDeviceTokenKey, null);
    let rDeviceId = dictPop(this.gdIdToUUID, rDeviceIdKey, null);

    // for storing reverse map
    this.UUIDToGdId = reverseDict(this.gdIdToUUID);

    // initialize remarkable api
    if (rDeviceToken === null) {
      this.rApiClient = new RemarkableAPI(null, null, rOneTimeCode);
      this.userProps.setProperty(rDeviceTokenKey, this.rApiClient.deviceToken);
      this.userProps.setProperty(rDeviceIdKey, this.rApiClient.deviceId);
    } else {
      this.rApiClient = new RemarkableAPI(rDeviceId, rDeviceToken);
    }

    // prep some common vars
    this.rDocList = this.rApiClient.listDocs(/*docUuid4=*/ null, /*withBlob=*/ true);
    Logger.log(`Found ${this.rDocList.length} items in Remarkable Cloud`)

    // for debugging - dump doc list as json in root google drive folder
    //DriveApp.createFile('remarkableDocList.json', JSON.stringify(this.rDocList));

    // create reverse dictionary
    this.rDocId2Ent = {}
    for (const [ix, doc] of this.rDocList.entries()) {
      this.rDocId2Ent[doc["ID"]] = ix;
    }

    // find root folder id
    if (isUUID(rRootFolderName)) {
      this.rRootFolderId = rRootFolderName;
    } else {
      let filteredDocs = this.rDocList.filter((r) => r["VissibleName"] == rRootFolderName);
      if (filteredDocs.length > 0) {
        this.rRootFolderId = filteredDocs[0]["ID"];
      }
      else {
        // TODO if can't find it, create folder at top level with rRootFolderName
        throw `Cannot find root file '${rRootFolderName}'`;
      }
    }
    Logger.log(`Mapped '${rRootFolderName}' to ID '${this.rRootFolderId}'`)
  }

  getUUID(gdId) {
    if (!(gdId in this.gdIdToUUID)) {
      let uuid = Utilities.getUuid();
      this.gdIdToUUID[gdId] = uuid;
      this.UUIDToGdId[uuid] = gdId;
    }
    return this.gdIdToUUID[gdId];
  }

  generateZipBlob(gdFileId) {
    let uuid = this.getUUID(gdFileId);
    let gdFileObj = DriveApp.getFileById(gdFileId);
    let gdFileMT = gdFileObj.getMimeType();

    if (gdFileMT == MimeType.SHORTCUT) {
      Logger.log(`Resolving shortcut to target file '${gdFileObj.getName()}'`);
      gdFileObj = DriveApp.getFileById(gdFileObj.getTargetId());
      gdFileMT = gdFileObj.getMimeType();
    }

    let zipBlob = null;

    if (gdFileMT == MimeType.FOLDER) {
      let contentBlob = Utilities.newBlob(JSON.stringify({})).setName(`${uuid}.content`);
      zipBlob = Utilities.zip([contentBlob]);
    } else {
      let gdFileExt = gdFileObj.getName().split('.').pop();
      let gdFileBlob = gdFileObj.getBlob().setName(`${uuid}.${gdFileExt}`);
      let pdBlob = Utilities.newBlob("").setName(`${uuid}.pagedata`);
      let contentData = {
        'extraMetadata': {},
        'fileType': gdFileExt,
        'lastOpenedPage': 0,
        'lineHeight': -1,
        'margins': 100,
        'pageCount': 0, // we don't know this, but it seems the reMarkable can count
        'textScale': 1,
        'transform': {} // no idea how to fill this, but it seems optional
      }
      let contentBlob = Utilities.newBlob(JSON.stringify(contentData)).setName(`${uuid}.content`);
      zipBlob = Utilities.zip([gdFileBlob, pdBlob, contentBlob]);
    }

    //DriveApp.createFile(zipBlob.setName(`rem-${uuid}.zip`)); // to debug/examine
    return zipBlob;
  }

  gdWalk(top, rParentId) {
    let uploadDocList = [];
    let _this = this;

    // top: GD folder currently being traversed
    // rParentId: ID of the RM parent folder for `top`.
    function _gdWalk(top, rParentId) {
      if (_this.gdFolderSkipList.includes(top.getName())) {
        Logger.log(`Skipping Google Drive sub folder '${top.getName()}'`)
        return;
      }
      Logger.log(`Scanning Google Drive sub folder '${top.getName()}'`)
      let topUUID = _this.getUUID(top.getId());
      uploadDocList.push({
        "ID": topUUID,
        "Type": "CollectionType",
        "Parent": rParentId,
        "VissibleName": top.getName(),
        "Version": 1,
        "_gdId": top.getId(),
        "_gdSize": top.getSize(),
      });

      let files = top.getFiles();
      while (files.hasNext()) {
        let file = files.next();
        uploadDocList.push({
          "ID": _this.getUUID(file.getId()),
          "Type": "DocumentType",
          "Parent": topUUID,
          "VissibleName": file.getName(),
          "Version": 1,
          "_gdId": file.getId(),
          "_gdSize": file.getSize(),
        });
      }

      let folders = top.getFolders();
      while (folders.hasNext()) {
        let folder = folders.next();
        _gdWalk(folder, topUUID);
      }
    }

    _gdWalk(top, rParentId);
    this.userProps.setProperties(this.gdIdToUUID);
    return uploadDocList;
  }

  _rServerVersion(r) {
    let ix = this.rDocId2Ent[r.ID];
    return ix === undefined ? undefined : this.rDocList[ix];
  }

  _isSyncDocument(r) {
    let name = r["VissibleName"];
    let isSyncExt = false;
	
	 for (const availableFormat of this.formats)
	 {
		if (name.endsWith(availableFormat))
		{
			isSyncExt = true;
			break;
		}				
	 }
	
    return r["Type"] == "DocumentType" && isSyncExt;
  }

  _needsUpdate(r) {
    let s = this._rServerVersion(r)
    if (!s) {
      let updateDoc = this._isSyncDocument(r) && r["_gdSize"] <= rMbUploadLimit;
      return updateDoc || r["Type"] == "CollectionType";
    }

    // force update
    if (this.forceUpdateFunc !== null && this.forceUpdateFunc(r, s)) {
      // bump up to server version
      r["Version"] = s["Version"] + 1;
      return true;
    }

    // verbose so can set breakpoints
    if (s["Parent"] != r["Parent"] || s["VissibleName"] != r["VissibleName"]) {
      // bump up to server version
      r["Version"] = s["Version"] + 1;
      r["CurrentPage"] = s["CurrentPage"];
      return true;
    }

    return false;
  }

  rAllDescendantIds() {
    // returns list of IDs all decendants
    let collected = [];
    let that = this;
    function _walkDocList(parentId) {
      collected.push(parentId);
      that.rDocList.filter(r => r.Parent == parentId).forEach(r => _walkDocList(r.ID));
    }
    _walkDocList(this.rRootFolderId);
    // remove the parentId (this typically won't come from Google Drive)
    return collected.filter(x => x !== this.rRootFolderId);
  }

  downloadUpdates(rDocList) {
    let ret = {updated: [], moved: []};
    for (let rDoc of rDocList) {
      // TODO(tk) not sure what !Success means in RM response.
      if (!rDoc.Success || rDoc.Type != 'DocumentType')
        continue;
      let cachedDoc = this.cacheInfo.cache[rDoc.ID];
      if (!cachedDoc || rDoc.Version > cachedDoc.Version) {
        Logger.info(
          `Downloading blob update for file
          ${rDoc.VissibleName} (v${rDoc.Version})...`);

        // TODO(tk) this assumes GDrive already has a folder with given name
        // If user creates new RM folder, won't work.
        let gdNewParentId = this.UUIDToGdId[rDoc.Parent];
        let gdNewParentFolder = gdNewParentId
          ? DriveApp.getFolderById(gdNewParentId)
          : this.cacheInfo.folder;

        let gdOldParentId = cachedDoc ? this.UUIDToGdId[cachedDoc.Parent] : null;
        let gdOldParentFolder = gdOldParentId
          ? DriveApp.getFolderById(gdOldParentId)
          : gdNewParentFolder;

        let blob = this.rApiClient.downloadBlob(rDoc);
        let currentBinFile = _updateOrCreate(gdOldParentFolder, blob);
        currentBinFile.moveTo(gdNewParentFolder);

        // NOTE(tk) ID could be null If PDF was never on GDrive.
        // NOTE(tk) file could be null if perma-deleted on GDrive.
        let gdPdfFileId = this.UUIDToGdId[rDoc.ID];
        let gdPdfFile = gdPdfFileId && DriveApp.getFileById(gdPdfFileId);
        if (gdPdfFile && gdOldParentId != gdNewParentId) {
          Logger.log(
            `Moving file from ${gdOldParentFolder.getName()}
            to ${gdNewParentFolder.getName()}`);
          gdPdfFile.moveTo(gdNewParentFolder);
          ret.moved.push(rDoc.ID);
        }

        ret.updated.push(rDoc.ID);

        Drive.Properties.insert({
          key: 'Version',
          value: rDoc.Version,
          visibility: 'PRIVATE'
        }, currentBinFile.getId());
      }
    }
    return ret;
  }

  run() {
    try {
      Logger.log(`Scanning Google Drive folder '${this.gdFolder.getName()}'...`)
      this.uploadDocList = this.gdWalk(this.gdFolder, this.rRootFolderId);

      Logger.log(`${this.uploadDocList.length} items in Google Drive folder.`)
      Logger.log(`Sync mode: ${this.syncMode}.`);

      let movedRmIds = new Set();
      let rDescIdsList = this.rAllDescendantIds();
      if (["2way", "2way-full"].includes(this.syncMode)) {
        Logger.log('Downloading updates from ReMarkable.');
        // 2way-full will also backup RM files not on GDrive
        let rDocList = this.syncMode === "2way-full"
          ? this.rDocList
          : this.rDocList.filter( rdoc => rDescIdsList.includes(rdoc.ID));
        try {
          let updated = this.downloadUpdates(rDocList)
          this.cacheInfo.save(rDocList);
          movedRmIds = new Set(updated.moved);
        } catch (err) {
          Logger.log(`Download failed with err ${err}.`);
        }
      }

      let rDescIds = new Set(rDescIdsList);
      if (["mirror", "2way", "2way-full"].includes(this.syncMode)) {
        Logger.log("Deleting files on Remarkable not on Google Drive.");
        let gdIds = new Set(this.uploadDocList.map(r => r.ID));
        let onRmButNotOnGd = rDescIds.difference(gdIds);
        // NOTE(tk) assumption: so long as a RM file is being updated
        let deleteList = this.rDocList.filter(
          r => onRmButNotOnGd.has(r.ID) && this._isSyncDocument(r));
        deleteList.forEach(r => {
          Logger.log(`Adding for deletion: ${r.VissibleName}`);
        });
        if (deleteList.length > 0) {
          Logger.log(`Deleting ${deleteList.length} docs that no longer exist in Google Drive`);
          this.rApiClient.delete(deleteList);
        }
      }

      // NOTE(tk) don't reupload files moved on ReMarkable.
      let updateDocList = this.uploadDocList.filter(
        r => !movedRmIds.has(r.ID) && this._needsUpdate(r));
      Logger.log(`Updating ${updateDocList.length} documents and folders..`)

      // chunk into 5 files at a time a loop
      for (const uploadDocChunk of chunk(updateDocList, 5)) {
        Logger.info(`Processing chunk of size ${uploadDocChunk.length}..`)

        // extract data for registration
        let uploadRequestResults = this.rApiClient.uploadRequest(uploadDocChunk);

        let deleteDocList = [];
        for (const doc of uploadRequestResults) {
          // upload files if not already on device.
          // if forced, upload regardless of whether they're on device.
          let alreadyOnDevice = rDescIds.has(doc["ID"]);
          let s = this._rServerVersion(doc);
          if (doc["Success"] && (this.forceUpdateFunc(doc, s) || !alreadyOnDevice)) {
            try {
              let gdFileId = this.UUIDToGdId[doc["ID"]];
              let gdFileObj = DriveApp.getFileById(gdFileId);
              Logger.log(`Attempting to upload '${gdFileObj.getName()}'; size ${gdFileObj.getSize()} bytes`);
              let gdFileBlob = this.generateZipBlob(gdFileId);
              Logger.log(`Generated Remarkable zip blob for '${gdFileObj.getName()}'`);
              this.rApiClient.blobUpload(doc["BlobURLPut"], gdFileBlob);
              Logger.log(`Uploaded '${gdFileObj.getName()}'`);
            } catch (err) {
              Logger.log(`Failed to upload '${doc["ID"]}': ${err}`);
              deleteDocList.push(doc);
            }
          }
        }

        // update metadata
        Logger.info("Updating meta data for chunk");
        let uploadUpdateStatusResults = this.rApiClient.uploadUpdateStatus(uploadDocChunk);
        for (const r of uploadUpdateStatusResults) {
          if (!r["Success"]) {
            let s = this._rServerVersion(r);
            Logger.log(`Failed to update status '${s["VissibleName"]}': ${r["Message"]}`)
          }
        }

        // delete failed uploads
        // do this after meta data update to ensure version matches.
        if (deleteDocList.length > 0) {
          Logger.log(`Deleting ${deleteDocList.length} docs that failed to upload`);
          this.rApiClient.delete(deleteDocList);
        }

        Logger.info("Finished processing chunk.");
      }

      Logger.info("Finished running!");
    }
    catch (err) {
      Logger.log(`Finished run with error: ${err}`);
    }
  }

}
