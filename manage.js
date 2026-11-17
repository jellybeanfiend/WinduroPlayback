const DISCIPLINES = ["Windsurf", "Windfoil", "Wingfoil", "Formula"];
const RACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_SYNC_LINE = {
  start: [47.565535, -122.192076],
  end: [47.565553, -122.196534],
};

const ui = {
  openRepository: document.querySelector("#open-repository"),
  repositoryName: document.querySelector("#repository-name"),
  status: document.querySelector("#manager-status"),
  editor: document.querySelector("#editor"),
  raceSelect: document.querySelector("#race-select"),
  newRace: document.querySelector("#new-race"),
  raceForm: document.querySelector("#race-form"),
  raceName: document.querySelector("#race-name"),
  raceDate: document.querySelector("#race-date"),
  raceId: document.querySelector("#race-id"),
  syncLineNote: document.querySelector("#sync-line-note"),
  saveRace: document.querySelector("#save-race"),
  cancelRace: document.querySelector("#cancel-race"),
  deleteRace: document.querySelector("#delete-race"),
  newTrack: document.querySelector("#new-track"),
  managedTracks: document.querySelector("#managed-tracks"),
  trackForm: document.querySelector("#track-form"),
  trackFormHeading: document.querySelector("#track-form-heading"),
  trackName: document.querySelector("#track-name"),
  trackDiscipline: document.querySelector("#track-discipline"),
  trackGear: document.querySelector("#track-gear"),
  trackColor: document.querySelector("#track-color"),
  trackGpx: document.querySelector("#track-gpx"),
  currentGpx: document.querySelector("#current-gpx"),
  timingStart: document.querySelector("#timing-start"),
  timingDuration: document.querySelector("#timing-duration"),
  trackStartTime: document.querySelector("#track-start-time"),
  saveTrack: document.querySelector("#save-track"),
  cancelTrack: document.querySelector("#cancel-track"),
};

let repositoryHandle = null;
let catalog = null;
let selectedRaceId = null;
let selectedManifest = null;
let editingTrackIndex = null;

function setStatus(message, kind = "") {
  ui.status.textContent = message;
  ui.status.dataset.kind = kind;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "An unexpected file operation failed.";
}

function isLocalHost() {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(window.location.hostname);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validateCatalog(value) {
  if (!value || !Array.isArray(value.races) || value.races.length === 0) {
    throw new Error("races.json must contain at least one race.");
  }
  const ids = new Set();
  for (const [index, race] of value.races.entries()) {
    if (
      !race ||
      typeof race.id !== "string" ||
      !RACE_ID_PATTERN.test(race.id) ||
      typeof race.name !== "string" ||
      !race.name.trim() ||
      !isValidDate(race.date) ||
      race.manifest !== `./tracks/${race.id}/race.json`
    ) {
      throw new Error(`Race ${index + 1} in races.json has an invalid ID, name, date, or manifest path.`);
    }
    if (ids.has(race.id)) throw new Error(`Race IDs must be unique; duplicate ID: ${race.id}.`);
    ids.add(race.id);
  }
}

function validateManifest(manifest, raceName) {
  if (!manifest || !Array.isArray(manifest.tracks)) {
    throw new Error(`${raceName} manifest must contain a tracks array.`);
  }
  const endpoints = ["start", "end"].map((key) => manifest.syncLine?.[key]);
  if (
    endpoints.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        point[0] < -90 ||
        point[0] > 90 ||
        point[1] < -180 ||
        point[1] > 180,
    )
  ) {
    throw new Error(`${raceName} manifest needs a valid two-point sync line.`);
  }
  const radians = Math.PI / 180;
  const [first, second] = endpoints;
  const latitudeDelta = (second[0] - first[0]) * radians;
  const longitudeDelta = (second[1] - first[1]) * radians;
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(first[0] * radians) *
      Math.cos(second[0] * radians) *
      Math.sin(longitudeDelta / 2) ** 2;
  if (6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)) < 1) {
    throw new Error(`${raceName} sync line endpoints must be at least one meter apart.`);
  }

  const names = new Set();
  const files = new Set();
  const colors = new Set();
  manifest.tracks.forEach((track, index) => {
    if (
      !track ||
      typeof track.name !== "string" ||
      !track.name.trim() ||
      !validFilename(track.file) ||
      !DISCIPLINES.includes(track.discipline) ||
      typeof track.color !== "string" ||
      !/^#[\da-f]{6}$/i.test(track.color)
    ) {
      throw new Error(`${raceName} track ${index + 1} has invalid participant metadata.`);
    }
    const name = track.name.trim().toLowerCase();
    const file = track.file.toLowerCase();
    const color = track.color.toLowerCase();
    if (names.has(name) || files.has(file) || colors.has(color)) {
      throw new Error(`${raceName} track names, filenames, and primary colors must be unique.`);
    }
    names.add(name);
    files.add(file);
    colors.add(color);
    if (
      track.secondaryColor !== undefined &&
      track.secondaryColor !== null &&
      (typeof track.secondaryColor !== "string" ||
        !/^#[\da-f]{6}$/i.test(track.secondaryColor) ||
        track.secondaryColor.toLowerCase() === color)
    ) {
      throw new Error(`${raceName} track ${track.name} has an invalid secondary color.`);
    }
  });
}

async function ensureReadWritePermission(handle = repositoryHandle) {
  if (!handle) throw new Error("Select the project folder first.");
  let permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    permission = await handle.requestPermission({ mode: "readwrite" });
  }
  if (permission !== "granted") {
    throw new Error("Read/write access to the project folder was not granted.");
  }
}

async function getDirectory(parent, name, create = false) {
  return parent.getDirectoryHandle(name, { create });
}

async function readText(directory, filename) {
  const fileHandle = await directory.getFileHandle(filename);
  return (await fileHandle.getFile()).text();
}

async function readJson(directory, filename) {
  try {
    return JSON.parse(await readText(directory, filename));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${filename} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function writeText(directory, filename, content) {
  const fileHandle = await directory.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Preserve the original write error for the user.
    }
    throw error;
  }
}

async function writeJson(directory, filename, value) {
  await writeText(directory, filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function loadCatalog() {
  catalog = await readJson(repositoryHandle, "races.json");
  validateCatalog(catalog);
}

function selectedRace() {
  return catalog?.races.find((race) => race.id === selectedRaceId) ?? null;
}

function raceDirectoryPath(raceId = selectedRaceId) {
  if (!RACE_ID_PATTERN.test(raceId)) throw new Error("Invalid race ID.");
  return `tracks/${raceId}/race.json`;
}

async function getRaceDirectory(raceId = selectedRaceId, create = false) {
  const tracksDirectory = await getDirectory(repositoryHandle, "tracks");
  return getDirectory(tracksDirectory, raceId, create);
}

async function writeCatalog() {
  validateCatalog(catalog);
  await writeJson(repositoryHandle, "races.json", catalog);
}

function renderRaceOptions() {
  ui.raceSelect.replaceChildren(
    ...catalog.races.map((race) => {
      const option = document.createElement("option");
      option.value = race.id;
      option.textContent = `${race.name} · ${race.date}`;
      return option;
    }),
  );
  ui.raceSelect.value = selectedRaceId;
}

async function loadSelectedRace() {
  const race = selectedRace();
  if (!race) throw new Error("Select a race.");
  const directory = await getRaceDirectory(race.id);
  selectedManifest = await readJson(directory, "race.json");
  validateManifest(selectedManifest, race.name);
  renderManagedTracks();
  fillRaceForm();
}

function renderManagedTracks() {
  const tracks = selectedManifest.tracks;
  if (tracks.length === 0) {
    ui.managedTracks.replaceChildren();
    const empty = document.createElement("li");
    empty.className = "managed-track-empty";
    empty.textContent = "No GPX tracks yet.";
    ui.managedTracks.append(empty);
    return;
  }

  ui.managedTracks.replaceChildren(
    ...tracks.map((track, index) => {
      const row = document.createElement("li");
      row.className = "managed-track";

      const description = document.createElement("div");
      description.className = "managed-track-description";
      const name = document.createElement("strong");
      name.textContent = track.name;
      const details = document.createElement("span");
      details.textContent = `${track.discipline} · ${track.file}`;
      description.append(name, details);

      const actions = document.createElement("div");
      actions.className = "manager-actions compact-actions";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => beginTrackEdit(index));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeTrack(index));
      actions.append(edit, remove);
      row.append(description, actions);
      return row;
    }),
  );
}

function fillRaceForm() {
  const race = selectedRace();
  ui.raceName.value = race.name;
  ui.raceDate.value = race.date;
  ui.raceId.value = race.id;
  ui.raceForm.hidden = false;
  ui.syncLineNote.hidden = true;
  ui.saveRace.textContent = "Save race";
  ui.deleteRace.hidden = false;
  ui.deleteRace.disabled = catalog.races.length === 1;
  ui.deleteRace.title = ui.deleteRace.disabled ? "At least one race must remain in the catalog." : "";
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "race";
}

function createRaceId(name, date) {
  const base = `${date}-${slugify(name)}`;
  const usedIds = new Set(catalog.races.map((race) => race.id));
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  ui.raceId.value = id;
  return id;
}

function updateGeneratedRaceId() {
  if (ui.raceForm.dataset.mode !== "create") return;
  ui.raceId.value =
    ui.raceName.value.trim() && isValidDate(ui.raceDate.value)
      ? createRaceId(ui.raceName.value.trim(), ui.raceDate.value)
      : "";
}

function startNewRace() {
  ui.raceForm.dataset.mode = "create";
  ui.raceForm.hidden = false;
  ui.raceName.value = "";
  const today = new Date();
  const pad = (part) => String(part).padStart(2, "0");
  ui.raceDate.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  ui.raceId.value = "";
  ui.syncLineNote.hidden = false;
  ui.saveRace.textContent = "Create race";
  ui.deleteRace.hidden = true;
  ui.trackForm.hidden = true;
  ui.newTrack.disabled = true;
  ui.managedTracks.replaceChildren();
  const note = document.createElement("li");
  note.className = "managed-track-empty";
  note.textContent = "Save the race before adding GPX tracks.";
  ui.managedTracks.append(note);
  updateGeneratedRaceId();
}

async function directoryExists(parent, name) {
  try {
    await parent.getDirectoryHandle(name);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

async function createRace(event) {
  event.preventDefault();
  try {
    await ensureReadWritePermission();
    const name = ui.raceName.value.trim();
    const date = ui.raceDate.value;
    if (!name || !isValidDate(date)) throw new Error("Enter a race name and a valid date.");

    const tracksDirectory = await getDirectory(repositoryHandle, "tracks");
    const baseId = createRaceId(name, date);
    let id = baseId;
    let suffix = 2;
    while (
      catalog.races.some((race) => race.id === id) ||
      (await directoryExists(tracksDirectory, id))
    ) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }

    const raceDirectory = await getDirectory(tracksDirectory, id, true);
    const sourceSyncLine = selectedManifest?.syncLine ?? DEFAULT_SYNC_LINE;
    const manifest = {
      syncLine: structuredClone(sourceSyncLine),
      tracks: [],
    };
    await writeJson(raceDirectory, "race.json", manifest);
    const race = { id, name, date, manifest: `./tracks/${id}/race.json` };
    catalog.races.push(race);
    try {
      await writeCatalog();
    } catch (error) {
      catalog.races.pop();
      throw new Error(`Race manifest was created, but races.json could not be updated: ${errorMessage(error)}`);
    }

    selectedRaceId = id;
    selectedManifest = manifest;
    ui.raceForm.dataset.mode = "edit";
    renderRaceOptions();
    renderManagedTracks();
    fillRaceForm();
    ui.newTrack.disabled = false;
    setStatus(`Created ${name}. Add its GPX tracks when ready.`, "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function updateRace(event) {
  event.preventDefault();
  try {
    if (ui.raceForm.dataset.mode === "create") {
      await createRace(event);
      return;
    }
    await ensureReadWritePermission();
    const race = selectedRace();
    if (!race) throw new Error("Select a race.");
    const name = ui.raceName.value.trim();
    const date = ui.raceDate.value;
    if (!name || !isValidDate(date)) throw new Error("Enter a race name and a valid date.");
    const previousName = race.name;
    const previousDate = race.date;
    race.name = name;
    race.date = date;
    try {
      await writeCatalog();
    } catch (error) {
      race.name = previousName;
      race.date = previousDate;
      throw error;
    }
    renderRaceOptions();
    fillRaceForm();
    setStatus(`Saved ${name}.`, "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function removeRace() {
  const race = selectedRace();
  if (!race || catalog.races.length === 1) return;
  const confirmed = window.confirm(
    `Remove "${race.name}" from the race catalog? Its manifest metadata will be removed; GPX files will stay in ${raceDirectoryPath().replace(/\/race\.json$/, "/")}.`,
  );
  if (!confirmed) return;
  try {
    await ensureReadWritePermission();
    const remaining = catalog.races.filter((entry) => entry.id !== race.id);
    const originalRaces = catalog.races;
    catalog.races = remaining;
    try {
      await writeCatalog();
    } catch (error) {
      catalog.races = originalRaces;
      throw error;
    }
    let cleanupWarning = "";
    try {
      const directory = await getRaceDirectory(race.id);
      await directory.removeEntry("race.json");
    } catch (error) {
      if (error.name !== "NotFoundError") {
        cleanupWarning = ` The catalog entry was removed, but the manifest file could not be removed: ${errorMessage(error)}`;
      }
    }
    selectedRaceId = remaining[0].id;
    renderRaceOptions();
    await loadSelectedRace();
    setStatus(
      `Removed ${race.name}; its GPX files remain in the project.${cleanupWarning}`,
      cleanupWarning ? "error" : "success",
    );
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

function candidateColor(tracks, currentIndex = null) {
  const used = new Set(
    tracks
      .filter((_, index) => index !== currentIndex)
      .map((track) => (typeof track.color === "string" ? track.color.toLowerCase() : "")),
  );
  const palette = window.WINDURO_TRACK_COLORS;
  const available = palette.find((color) => !used.has(color.toLowerCase()));
  if (available) return available;

  for (let hue = 0; hue < 360; hue += 7) {
    const hex = hslToHex(hue, 0.72, 0.54);
    if (!used.has(hex)) return hex;
  }
  throw new Error("Could not choose an unused color.");
}

function hslToHex(hue, saturation, lightness) {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1 ? [chroma, x, 0] :
      section < 2 ? [x, chroma, 0] :
        section < 3 ? [0, chroma, x] :
          section < 4 ? [0, x, chroma] :
            section < 5 ? [x, 0, chroma] : [chroma, 0, x];
  const match = lightness - chroma / 2;
  return `#${[red, green, blue]
    .map((value) => Math.round((value + match) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function localDateTimeValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part) => String(part).padStart(2, "0");
  const milliseconds = date.getMilliseconds();
  const fraction = milliseconds ? `.${String(milliseconds).padStart(3, "0")}` : "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${fraction}`;
}

function isoDateTimeValue(value) {
  return value ? new Date(value).toISOString() : null;
}

function beginTrackCreate() {
  editingTrackIndex = null;
  ui.trackForm.reset();
  ui.trackFormHeading.textContent = "Add GPX track";
  ui.currentGpx.textContent = "Choose a GPX file to copy into this race’s folder.";
  ui.trackColor.value = candidateColor(selectedManifest.tracks);
  ui.trackForm.hidden = false;
  ui.trackName.focus();
}

function beginTrackEdit(index) {
  const track = selectedManifest.tracks[index];
  if (!track) return;
  editingTrackIndex = index;
  ui.trackForm.reset();
  ui.trackFormHeading.textContent = `Edit ${track.name}`;
  ui.trackName.value = track.name;
  ui.trackDiscipline.value = track.discipline;
  ui.trackGear.value = track.gear ?? "";
  ui.trackColor.value = track.color;
  ui.currentGpx.textContent = `Current file: ${track.file}. Choose a replacement only if needed.`;
  ui.timingStart.value = localDateTimeValue(track.timing?.start);
  ui.timingDuration.value = track.timing?.durationSeconds ?? "";
  ui.trackStartTime.value = localDateTimeValue(track.startTime);
  ui.trackForm.hidden = false;
  ui.trackName.focus();
}

function hideTrackForm() {
  ui.trackForm.hidden = true;
  ui.trackForm.reset();
  editingTrackIndex = null;
}

function getTrackPoints(xmlDocument, filename) {
  if (xmlDocument.querySelector("parsererror") || xmlDocument.documentElement?.localName.toLowerCase() !== "gpx") {
    throw new Error(`${filename} is not a valid GPX XML document.`);
  }
  const points = [...xmlDocument.getElementsByTagName("*")].filter((element) => element.localName === "trkpt");
  if (points.length < 2) throw new Error(`${filename} must contain at least two track points.`);
  const timestamps = [];
  for (const [index, point] of points.entries()) {
    const latitudeValue = point.getAttribute("lat");
    const longitudeValue = point.getAttribute("lon");
    const latitude = latitudeValue?.trim() ? Number(latitudeValue) : Number.NaN;
    const longitude = longitudeValue?.trim() ? Number(longitudeValue) : Number.NaN;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(`${filename} point ${index + 1} has an invalid latitude.`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(`${filename} point ${index + 1} has an invalid longitude.`);
    }
    const timeElement = [...point.children].find((child) => child.localName === "time");
    timestamps.push(timeElement?.textContent?.trim() || null);
  }

  const count = timestamps.filter(Boolean).length;
  if (count > 0 && count !== points.length) {
    throw new Error(`${filename} must have timestamps on every point or none.`);
  }
  if (count === points.length) {
    const epochs = timestamps.map((value, index) => {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw new Error(`${filename} point ${index + 1} has an invalid or timezone-free timestamp.`);
      }
      const epoch = Date.parse(value);
      if (!Number.isFinite(epoch)) throw new Error(`${filename} point ${index + 1} has an invalid timestamp.`);
      return epoch;
    });
    if (epochs.some((epoch, index) => index > 0 && epoch < epochs[index - 1])) {
      throw new Error(`${filename} timestamps must be chronological.`);
    }
    if (epochs.at(-1) <= epochs[0]) throw new Error(`${filename} timestamps must span a positive duration.`);
    return { hasTimestamps: true, firstTimestamp: epochs[0], lastTimestamp: epochs.at(-1) };
  }
  return { hasTimestamps: false, firstTimestamp: null, lastTimestamp: null };
}

async function inspectGpx(file, filename) {
  const text = await file.text();
  const document = new DOMParser().parseFromString(text, "application/xml");
  return getTrackPoints(document, filename);
}

async function existingGpx(track) {
  const directory = await getRaceDirectory();
  const file = await directory.getFileHandle(track.file);
  return file.getFile();
}

function validFilename(filename) {
  return (
    typeof filename === "string" &&
    filename.toLowerCase().endsWith(".gpx") &&
    !/[<>:"/\\|?*\u0000-\u001f]/.test(filename) &&
    filename !== "." &&
    filename !== ".."
  );
}

function validateStartTime(startTime, gpx, timing) {
  if (!startTime) return;
  const epoch = Date.parse(startTime);
  if (!Number.isFinite(epoch)) throw new Error("Sync start override must be a valid date and time.");
  if (gpx.hasTimestamps && (epoch < gpx.firstTimestamp || epoch > gpx.lastTimestamp)) {
    throw new Error("Sync start override must fall within the GPX timestamp range.");
  }
  if (!gpx.hasTimestamps && timing) {
    const startEpoch = Date.parse(timing.start);
    if (epoch < startEpoch || epoch >= startEpoch + timing.durationSeconds * 1000) {
      throw new Error("Sync start override must fall within the timing duration.");
    }
  }
}

async function fileExists(directory, filename) {
  try {
    await directory.getFileHandle(filename);
    return true;
  } catch (error) {
    if (error.name === "NotFoundError") return false;
    throw error;
  }
}

async function availableGpxFilename(directory, requestedFilename, tracks) {
  const extensionIndex = requestedFilename.lastIndexOf(".");
  const stem = requestedFilename.slice(0, extensionIndex);
  const extension = requestedFilename.slice(extensionIndex);
  let filename = requestedFilename;
  let suffix = 2;
  while (
    tracks.some((track) => track.file.toLowerCase() === filename.toLowerCase()) ||
    (await fileExists(directory, filename))
  ) {
    filename = `${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return filename;
}

async function copyGpxFile(directory, file, filename) {
  if (await fileExists(directory, filename)) {
    throw new Error(`${filename} appeared in this race folder while saving. Retry the save to choose an unused filename.`);
  }
  const destination = await directory.getFileHandle(filename, { create: true });
  const writable = await destination.createWritable();
  try {
    await writable.write(await file.arrayBuffer());
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Preserve the original copy error.
    }
    throw error;
  }
}

async function saveTrack(event) {
  event.preventDefault();
  const isNewTrack = editingTrackIndex === null;
  try {
    await ensureReadWritePermission();
    const name = ui.trackName.value.trim();
    const discipline = ui.trackDiscipline.value;
    const gear = ui.trackGear.value.trim();
    const color = ui.trackColor.value.toLowerCase();
    if (!name) throw new Error("Enter a participant name.");
    if (!DISCIPLINES.includes(discipline)) throw new Error("Choose a supported discipline.");
    if (!/^#[\da-f]{6}$/.test(color)) throw new Error("Choose a valid six-digit color.");

    const currentTrack =
      editingTrackIndex === null ? null : selectedManifest.tracks[editingTrackIndex];
    const chosenFile = ui.trackGpx.files[0] ?? null;
    if (!currentTrack && !chosenFile) throw new Error("Choose a GPX file for this participant.");
    const requestedFilename = chosenFile?.name ?? currentTrack.file;
    if (!validFilename(requestedFilename)) throw new Error("Choose a GPX file with a valid .gpx filename.");
    const otherTracks = selectedManifest.tracks.filter((_, index) => index !== editingTrackIndex);
    if (otherTracks.some((track) => track.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A participant named ${name} is already in this race.`);
    }
    if (otherTracks.some((track) => track.color.toLowerCase() === color)) {
      throw new Error("Each participant in a race needs a unique track color.");
    }
    if (currentTrack?.secondaryColor?.toLowerCase() === color) {
      throw new Error("The primary track color must differ from its secondary color.");
    }

    const timingStart = isoDateTimeValue(ui.timingStart.value);
    const durationValue = ui.timingDuration.value.trim();
    let timing = null;
    if (timingStart || durationValue) {
      const durationSeconds = Number(durationValue);
      if (!timingStart || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error("Untimed GPX timing needs both a recording start and positive duration.");
      }
      timing = { start: timingStart, durationSeconds };
    }
    const startTime = isoDateTimeValue(ui.trackStartTime.value);
    const raceDirectory = await getRaceDirectory();
    const filename = chosenFile
      ? await availableGpxFilename(raceDirectory, requestedFilename, otherTracks)
      : requestedFilename;
    if (otherTracks.some((track) => track.file.toLowerCase() === filename.toLowerCase())) {
      throw new Error(`${filename} is already assigned to another participant.`);
    }

    let gpx;
    if (chosenFile) {
      gpx = await inspectGpx(chosenFile, filename);
    } else {
      gpx = await inspectGpx(await existingGpx(currentTrack), filename);
    }
    if (gpx.hasTimestamps && timing) {
      throw new Error("Timing metadata is only for GPX files without point timestamps.");
    }
    if (!gpx.hasTimestamps && !timing) {
      throw new Error("This GPX has no point timestamps. Enter its recording start and duration under Optional timing metadata.");
    }
    validateStartTime(startTime, gpx, timing);

    const updatedTrack = {
      ...currentTrack,
      name,
      file: filename,
      discipline,
      color,
    };
    if (gear) updatedTrack.gear = gear;
    else delete updatedTrack.gear;
    if (timing) updatedTrack.timing = timing;
    else delete updatedTrack.timing;
    if (startTime) updatedTrack.startTime = startTime;
    else delete updatedTrack.startTime;

    let copiedGpx = false;
    if (chosenFile) {
      await copyGpxFile(raceDirectory, chosenFile, filename);
      copiedGpx = true;
    }
    const nextTracks = [...selectedManifest.tracks];
    if (editingTrackIndex === null) nextTracks.push(updatedTrack);
    else nextTracks[editingTrackIndex] = updatedTrack;
    const nextManifest = { ...selectedManifest, tracks: nextTracks };
    try {
      await writeJson(raceDirectory, "race.json", nextManifest);
    } catch (error) {
      if (copiedGpx) {
        throw new Error(`GPX was copied, but race.json could not be updated: ${errorMessage(error)}`);
      }
      throw error;
    }
    selectedManifest = nextManifest;
    renderManagedTracks();
    hideTrackForm();
    setStatus(`${isNewTrack ? "Added" : "Saved"} ${name}.`, "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function removeTrack(index) {
  const track = selectedManifest.tracks[index];
  if (!track || !window.confirm(`Remove ${track.name} from this race? The GPX file ${track.file} will stay in the race folder.`)) {
    return;
  }
  try {
    await ensureReadWritePermission();
    const nextManifest = {
      ...selectedManifest,
      tracks: selectedManifest.tracks.filter((_, currentIndex) => currentIndex !== index),
    };
    await writeJson(await getRaceDirectory(), "race.json", nextManifest);
    selectedManifest = nextManifest;
    renderManagedTracks();
    hideTrackForm();
    setStatus(`Removed ${track.name}; ${track.file} remains in the race folder.`, "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
}

async function openRepository() {
  if (!isLocalHost()) {
    setStatus("The race editor can only access files when opened from localhost.", "error");
    return;
  }
  if (!("showDirectoryPicker" in window)) {
    setStatus("This browser does not support direct folder access. Use a recent version of Chrome or Edge.", "error");
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await ensureReadWritePermission(handle);
    await handle.getFileHandle("races.json");
    await getDirectory(handle, "tracks");
    repositoryHandle = handle;
    await loadCatalog();
    selectedRaceId = catalog.races[0].id;
    ui.repositoryName.textContent = handle.name;
    ui.editor.hidden = false;
    renderRaceOptions();
    await loadSelectedRace();
    setStatus("Project folder opened. Changes save directly to its files.", "success");
  } catch (error) {
    if (error.name === "AbortError") return;
    setStatus(errorMessage(error), "error");
  }
}

ui.openRepository.addEventListener("click", openRepository);
ui.raceSelect.addEventListener("change", async () => {
  selectedRaceId = ui.raceSelect.value;
  ui.trackForm.hidden = true;
  ui.raceForm.dataset.mode = "edit";
  ui.newTrack.disabled = false;
  try {
    await loadSelectedRace();
    setStatus(`Editing ${selectedRace().name}.`, "success");
  } catch (error) {
    setStatus(errorMessage(error), "error");
  }
});
ui.newRace.addEventListener("click", startNewRace);
ui.raceName.addEventListener("input", updateGeneratedRaceId);
ui.raceDate.addEventListener("input", updateGeneratedRaceId);
ui.raceForm.addEventListener("submit", updateRace);
ui.cancelRace.addEventListener("click", () => {
  ui.raceForm.dataset.mode = "edit";
  ui.newTrack.disabled = false;
  fillRaceForm();
  renderManagedTracks();
});
ui.deleteRace.addEventListener("click", removeRace);
ui.newTrack.addEventListener("click", beginTrackCreate);
ui.trackForm.addEventListener("submit", saveTrack);
ui.cancelTrack.addEventListener("click", hideTrackForm);

if (!isLocalHost()) {
  ui.openRepository.disabled = true;
  setStatus("This editor is local-only. Open it from localhost to access a project folder.", "error");
} else if (!("showDirectoryPicker" in window)) {
  setStatus("Direct folder editing requires a recent version of Chrome or Edge. Open this page from localhost.", "error");
}
