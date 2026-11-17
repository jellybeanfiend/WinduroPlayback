const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MockFile {
  constructor(name, content = "") {
    this.name = name;
    this.content = new TextEncoder().encode(content);
  }

  async text() {
    return new TextDecoder().decode(this.content);
  }

  async arrayBuffer() {
    return this.content.slice().buffer;
  }
}

class MockFileHandle {
  constructor(name, content = "") {
    this.name = name;
    this.content = new TextEncoder().encode(content);
  }

  async getFile() {
    const file = new MockFile(this.name);
    file.content = this.content;
    return file;
  }

  async createWritable() {
    let nextContent;
    return {
      write: async (content) => {
        nextContent =
          typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
      },
      close: async () => {
        this.content = nextContent;
      },
      abort: async () => {},
    };
  }
}

class MockDirectory {
  constructor(name) {
    this.name = name;
    this.entries = new Map();
  }

  async queryPermission() {
    return "granted";
  }

  async requestPermission() {
    return "granted";
  }

  async getFileHandle(name, { create = false } = {}) {
    let handle = this.entries.get(name);
    if (!handle && create) {
      handle = new MockFileHandle(name);
      this.entries.set(name, handle);
    }
    if (!handle) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    if (!(handle instanceof MockFileHandle)) {
      throw Object.assign(new Error(`${name} is a directory`), { name: "TypeMismatchError" });
    }
    return handle;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    let handle = this.entries.get(name);
    if (!handle && create) {
      handle = new MockDirectory(name);
      this.entries.set(name, handle);
    }
    if (!handle) throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    if (!(handle instanceof MockDirectory)) {
      throw Object.assign(new Error(`${name} is a file`), { name: "TypeMismatchError" });
    }
    return handle;
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) {
      throw Object.assign(new Error(`${name} not found`), { name: "NotFoundError" });
    }
  }
}

class MockElement {
  constructor(id = "") {
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.disabled = false;
    this.hidden = false;
    this.dataset = {};
    this.files = [];
    this.children = [];
    this.listeners = {};
  }

  addEventListener(name, callback) {
    (this.listeners[name] ??= []).push(callback);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  append(...children) {
    this.children.push(...children);
  }

  focus() {}

  reset() {
    this.files = [];
  }
}

function timedPoint(latitude, longitude, timestamp) {
  return {
    localName: "trkpt",
    getAttribute(name) {
      return name === "lat" ? String(latitude) : String(longitude);
    },
    children: [{ localName: "time", textContent: timestamp }],
  };
}

class MockDOMParser {
  parseFromString() {
    return {
      querySelector: () => null,
      documentElement: { localName: "gpx" },
      getElementsByTagName: () => [
        timedPoint(47.5, -122.2, "2026-12-01T10:00:00Z"),
        timedPoint(47.6, -122.2, "2026-12-01T10:01:00Z"),
      ],
    };
  }
}

function createEditorContext(hostname = "localhost") {
  const root = new MockDirectory("WinduroPlayback");
  const tracksDirectory = new MockDirectory("tracks");
  const currentRaceId = "winduro-2026";
  root.entries.set("tracks", tracksDirectory);
  root.entries.set(
    "races.json",
    new MockFileHandle(
      "races.json",
      JSON.stringify({
        races: [
          {
            id: currentRaceId,
            name: "Winduro 2026",
            date: "2026-11-08",
            manifest: `./tracks/${currentRaceId}/race.json`,
          },
        ],
      }),
    ),
  );
  const currentRaceDirectory = new MockDirectory(currentRaceId);
  currentRaceDirectory.entries.set(
    "race.json",
    new MockFileHandle(
      "race.json",
      JSON.stringify({
        syncLine: { start: [47.5, -122.2], end: [47.5, -122.19] },
        tracks: [],
      }),
    ),
  );
  tracksDirectory.entries.set(currentRaceId, currentRaceDirectory);

  const ids = [
    "open-repository", "repository-name", "manager-status", "editor", "race-select", "new-race",
    "race-form", "race-name", "race-date", "race-id", "sync-line-note", "save-race",
    "cancel-race", "delete-race", "new-track", "managed-tracks", "track-form",
    "track-form-heading", "track-name", "track-discipline", "track-gear", "track-color",
    "track-gpx", "current-gpx", "timing-start", "timing-duration", "track-start-time",
    "save-track", "cancel-track",
  ];
  const elements = new Map(ids.map((id) => [`#${id}`, new MockElement(id)]));
  elements.get("#track-form").reset = () => {
    elements.get("#track-gpx").files = [];
  };
  const document = {
    querySelector: (selector) => elements.get(selector),
    createElement: (tag) => new MockElement(tag),
  };
  const window = {
    location: { hostname },
    showDirectoryPicker: async () => root,
    confirm: () => true,
    WINDURO_TRACK_COLORS: ["#59d5ff", "#ffcb5b"],
  };
  const context = vm.createContext({
    window,
    document,
    DOMParser: MockDOMParser,
    structuredClone,
    TextEncoder,
    TextDecoder,
  });
  return { context, elements, root, tracksDirectory };
}

async function trigger(elements, id, type) {
  for (const callback of elements.get(`#${id}`).listeners[type] ?? []) {
    await callback({ preventDefault() {} });
  }
}

async function readJson(directory, filename) {
  return JSON.parse(await (await directory.getFileHandle(filename)).getFile().then((file) => file.text()));
}

test("local editor creates races and manages GPX metadata without deleting track files", async () => {
  const { context, elements, root, tracksDirectory } = createEditorContext();
  const script = await readFile(path.join(__dirname, "..", "manage.js"), "utf8");
  vm.runInContext(script, context);

  await trigger(elements, "open-repository", "click");
  await trigger(elements, "new-race", "click");
  elements.get("#race-name").value = "Test Race";
  elements.get("#race-date").value = "2026-12-01";
  await trigger(elements, "race-form", "submit");

  const newRace = (await readJson(root, "races.json")).races.find((race) => race.name === "Test Race");
  assert.equal(newRace.id, "2026-12-01-test-race");
  const raceDirectory = await tracksDirectory.getDirectoryHandle(newRace.id);

  elements.get("#race-name").value = "Renamed Race";
  elements.get("#race-date").value = "2026-12-02";
  await trigger(elements, "race-form", "submit");
  const editedRace = (await readJson(root, "races.json")).races.find((race) => race.id === newRace.id);
  assert.equal(editedRace.name, "Renamed Race");
  assert.equal(editedRace.date, "2026-12-02");
  assert.equal(editedRace.id, newRace.id);

  await trigger(elements, "new-track", "click");
  assert.equal(elements.get("#track-color").value, "#59d5ff");
  elements.get("#track-name").value = "Rider One";
  elements.get("#track-discipline").value = "Windsurf";
  elements.get("#track-gear").value = "Test sail";
  elements.get("#track-color").value = "#59d5ff";
  elements.get("#track-gpx").files = [new MockFile("Rider.gpx", "<gpx/>")];
  await trigger(elements, "track-form", "submit");

  let manifest = await readJson(raceDirectory, "race.json");
  assert.equal(manifest.tracks[0].name, "Rider One");
  assert.equal(manifest.tracks[0].file, "Rider.gpx");
  assert.equal(await (await raceDirectory.getFileHandle("Rider.gpx")).getFile().then((file) => file.text()), "<gpx/>");

  const editButton = elements.get("#managed-tracks").children[0].children[1].children[0];
  await editButton.listeners.click[0]();
  elements.get("#track-name").value = "Rider Updated";
  elements.get("#track-color").value = "#ffcb5b";
  await trigger(elements, "track-form", "submit");
  manifest = await readJson(raceDirectory, "race.json");
  assert.equal(manifest.tracks[0].name, "Rider Updated");

  const removeTrackButton = elements.get("#managed-tracks").children[0].children[1].children[1];
  await removeTrackButton.listeners.click[0]();
  assert.equal((await readJson(raceDirectory, "race.json")).tracks.length, 0);
  assert.ok(await raceDirectory.getFileHandle("Rider.gpx"));

  await trigger(elements, "new-track", "click");
  elements.get("#track-name").value = "Rider Two";
  elements.get("#track-discipline").value = "Windfoil";
  elements.get("#track-color").value = "#59d5ff";
  elements.get("#track-gpx").files = [new MockFile("Rider.gpx", "<gpx/>")];
  await trigger(elements, "track-form", "submit");
  manifest = await readJson(raceDirectory, "race.json");
  assert.equal(manifest.tracks[0].file, "Rider-2.gpx");
  assert.ok(await raceDirectory.getFileHandle("Rider.gpx"));
  assert.ok(await raceDirectory.getFileHandle("Rider-2.gpx"));

  elements.get("#race-select").value = newRace.id;
  await trigger(elements, "race-select", "change");
  await trigger(elements, "delete-race", "click");
  assert.equal((await readJson(root, "races.json")).races.length, 1);
  assert.equal(raceDirectory.entries.has("race.json"), false);
  assert.ok(await raceDirectory.getFileHandle("Rider.gpx"));
  assert.ok(await raceDirectory.getFileHandle("Rider-2.gpx"));
});

test("editor refuses filesystem access when served from a non-local host", async () => {
  const { context, elements } = createEditorContext("winduro.example");
  const script = await readFile(path.join(__dirname, "..", "manage.js"), "utf8");
  vm.runInContext(script, context);

  assert.equal(elements.get("#open-repository").disabled, true);
  await trigger(elements, "open-repository", "click");
  assert.match(elements.get("#manager-status").textContent, /localhost/i);
});
