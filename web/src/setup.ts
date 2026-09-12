// Setup page: home station search, config inputs, live URL + QR preview.
//
// This page only builds the widget URL from user input; it does not read or
// write localStorage itself (the widget's own config.ts owns persistence).
import { renderQrCode } from "./qr";

/*---- Config defaults (must match web/src/config.ts / IMPLEMENTATION_PLAN.md 4.2) ----*/

type ThemeMode = "dark" | "light";
type Arrow = "heading" | "north";
type RankMode = "earliest" | "homeBy";

interface Defaults {
  v: number;
  pack: number;
  walk: number;
  margin: number;
  lmax: number;
  lsafe: number;
  lamber: number;
  mode: ThemeMode;
  refresh: number;
  maxRoute: number;
  arrow: Arrow;
  rankMode: RankMode;
}

const DEFAULTS: Defaults = {
  v: 34,
  pack: 10,
  walk: 5,
  margin: 150,
  lmax: 15,
  lsafe: 6,
  lamber: 9,
  mode: "dark",
  refresh: 120,
  maxRoute: 8,
  arrow: "heading",
  rankMode: "earliest",
};

/*---- DOM handles ----*/

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
}

const homeSearch = el<HTMLInputElement>("home-search");
const homeResults = el<HTMLUListElement>("home-results");
const homeSearchStatus = el<HTMLDivElement>("home-search-status");
const selectedHomeBox = el<HTMLDivElement>("selected-home");

const inputs = {
  v: el<HTMLInputElement>("cfg-v"),
  pack: el<HTMLInputElement>("cfg-pack"),
  walk: el<HTMLInputElement>("cfg-walk"),
  margin: el<HTMLInputElement>("cfg-margin"),
  lmax: el<HTMLInputElement>("cfg-lmax"),
  lsafe: el<HTMLInputElement>("cfg-lsafe"),
  lamber: el<HTMLInputElement>("cfg-lamber"),
  mode: el<HTMLSelectElement>("cfg-mode"),
  refresh: el<HTMLInputElement>("cfg-refresh"),
  maxRoute: el<HTMLInputElement>("cfg-maxRoute"),
  arrow: el<HTMLSelectElement>("cfg-arrow"),
  rankMode: el<HTMLSelectElement>("cfg-rankMode"),
  homeBy: el<HTMLInputElement>("cfg-homeBy"),
};

const homeByField = el<HTMLDivElement>("homeby-field");
const homeByMinus = el<HTMLButtonElement>("homeby-minus");
const homeByPlus = el<HTMLButtonElement>("homeby-plus");

const urlPreview = el<HTMLElement>("url-preview");
const urlWarning = el<HTMLDivElement>("url-warning");
const copyButton = el<HTMLButtonElement>("copy-url");
const copyStatus = el<HTMLDivElement>("copy-status");
const testLink = el<HTMLAnchorElement>("test-link");
const qrWrap = el<HTMLDivElement>("qr-wrap");

/*---- Home station search ----*/

interface LocationEntry {
  id: string | null;
  name: string;
}
interface LocationsResponse {
  stations: LocationEntry[];
}

let selectedHome: { id: number; name: string } | null = null;
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let searchAbort: AbortController | null = null;

function clearResults(): void {
  homeResults.innerHTML = "";
  homeResults.setAttribute("aria-expanded", "false");
}

async function runSearch(query: string): Promise<void> {
  if (searchAbort) searchAbort.abort();
  const controller = new AbortController();
  searchAbort = controller;
  homeSearchStatus.textContent = "Searching...";
  try {
    const url = `https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(query)}&type=station`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as LocationsResponse;
    const stations = (data.stations ?? []).filter(
      (s): s is LocationEntry & { id: string } => s.id !== null && s.id !== "",
    );
    renderResults(stations);
    homeSearchStatus.textContent = stations.length === 0 ? "No stations found." : "";
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return;
    clearResults();
    homeSearchStatus.textContent = "Search failed; check your connection and try again.";
  }
}

function renderResults(stations: Array<{ id: string; name: string }>): void {
  homeResults.innerHTML = "";
  for (const s of stations) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.tabIndex = 0;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = s.name;
    const idSpan = document.createElement("span");
    idSpan.className = "stop-id";
    idSpan.textContent = s.id;

    li.appendChild(nameSpan);
    li.appendChild(idSpan);

    const select = (): void => {
      const idNum = Number(s.id);
      if (!Number.isFinite(idNum)) return;
      selectedHome = { id: idNum, name: s.name };
      homeSearch.value = s.name;
      clearResults();
      showSelectedHome();
      updatePreview();
    };
    li.addEventListener("click", select);
    li.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        select();
      }
    });

    homeResults.appendChild(li);
  }
  homeResults.setAttribute("aria-expanded", stations.length > 0 ? "true" : "false");
}

function showSelectedHome(): void {
  if (!selectedHome) {
    selectedHomeBox.hidden = true;
    return;
  }
  selectedHomeBox.hidden = false;
  selectedHomeBox.textContent = "";
  const label = document.createElement("span");
  label.textContent = "Home: ";
  const strong = document.createElement("strong");
  strong.textContent = `${selectedHome.name} (${selectedHome.id})`;
  selectedHomeBox.appendChild(label);
  selectedHomeBox.appendChild(strong);
}

homeSearch.addEventListener("input", () => {
  const query = homeSearch.value.trim();
  selectedHome = null;
  showSelectedHome();
  updatePreview();
  if (searchDebounce) clearTimeout(searchDebounce);
  if (query.length === 0) {
    clearResults();
    homeSearchStatus.textContent = "";
    return;
  }
  searchDebounce = setTimeout(() => {
    void runSearch(query);
  }, 300);
});

homeSearch.addEventListener("blur", () => {
  // Let a click on a result register before the list disappears.
  setTimeout(clearResults, 150);
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") clearResults();
});

/*---- Home-by time default (now + 3h, rounded up to 15 min) ----*/

function defaultHomeBy(): string {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const minutes = d.getMinutes();
  const rounded = Math.ceil(minutes / 15) * 15;
  d.setMinutes(rounded % 60, 0, 0);
  if (rounded >= 60) d.setHours(d.getHours() + 1);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function shiftHomeBy(deltaMin: number): void {
  const [hStr, mStr] = inputs.homeBy.value.split(":");
  const h = Number(hStr ?? 0);
  const m = Number(mStr ?? 0);
  const total = ((h * 60 + m + deltaMin) % (24 * 60) + 24 * 60) % (24 * 60);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  inputs.homeBy.value = `${hh}:${mm}`;
  updatePreview();
}

/*---- Field wiring ----*/

function initDefaults(): void {
  inputs.v.value = String(DEFAULTS.v);
  inputs.pack.value = String(DEFAULTS.pack);
  inputs.walk.value = String(DEFAULTS.walk);
  inputs.margin.value = String(DEFAULTS.margin);
  inputs.lmax.value = String(DEFAULTS.lmax);
  inputs.lsafe.value = String(DEFAULTS.lsafe);
  inputs.lamber.value = String(DEFAULTS.lamber);
  inputs.mode.value = DEFAULTS.mode;
  inputs.refresh.value = String(DEFAULTS.refresh);
  inputs.maxRoute.value = String(DEFAULTS.maxRoute);
  inputs.arrow.value = DEFAULTS.arrow;
  inputs.rankMode.value = DEFAULTS.rankMode;
  inputs.homeBy.value = defaultHomeBy();
}

function updateHomeByVisibility(): void {
  homeByField.hidden = inputs.rankMode.value !== "homeBy";
}

for (const input of Object.values(inputs)) {
  input.addEventListener("input", updatePreview);
  input.addEventListener("change", updatePreview);
}
inputs.rankMode.addEventListener("change", () => {
  updateHomeByVisibility();
  updatePreview();
});
homeByMinus.addEventListener("click", () => shiftHomeBy(-15));
homeByPlus.addEventListener("click", () => shiftHomeBy(15));

/*---- URL + QR preview ----*/

function widgetBaseUrl(): URL {
  const base = import.meta.env.BASE_URL;
  return new URL(`${base}index.html`, location.origin);
}

function buildWidgetUrl(): URL | null {
  if (!selectedHome) return null;
  const url = widgetBaseUrl();
  const params = url.searchParams;
  params.set("home", String(selectedHome.id));
  params.set("homeName", selectedHome.name);

  const v = Number(inputs.v.value);
  if (Number.isFinite(v) && v !== DEFAULTS.v) params.set("v", String(v));
  const pack = Number(inputs.pack.value);
  if (Number.isFinite(pack) && pack !== DEFAULTS.pack) params.set("pack", String(pack));
  const walk = Number(inputs.walk.value);
  if (Number.isFinite(walk) && walk !== DEFAULTS.walk) params.set("walk", String(walk));
  const margin = Number(inputs.margin.value);
  if (Number.isFinite(margin) && margin !== DEFAULTS.margin) params.set("margin", String(margin));
  const lmax = Number(inputs.lmax.value);
  if (Number.isFinite(lmax) && lmax !== DEFAULTS.lmax) params.set("lmax", String(lmax));
  const lsafe = Number(inputs.lsafe.value);
  if (Number.isFinite(lsafe) && lsafe !== DEFAULTS.lsafe) params.set("lsafe", String(lsafe));
  const lamber = Number(inputs.lamber.value);
  if (Number.isFinite(lamber) && lamber !== DEFAULTS.lamber) params.set("lamber", String(lamber));
  if (inputs.mode.value !== DEFAULTS.mode) params.set("mode", inputs.mode.value);
  const refresh = Number(inputs.refresh.value);
  if (Number.isFinite(refresh) && refresh !== DEFAULTS.refresh) params.set("refresh", String(refresh));
  const maxRoute = Number(inputs.maxRoute.value);
  if (Number.isFinite(maxRoute) && maxRoute !== DEFAULTS.maxRoute)
    params.set("maxRoute", String(maxRoute));
  if (inputs.arrow.value !== DEFAULTS.arrow) params.set("arrow", inputs.arrow.value);
  if (inputs.rankMode.value !== DEFAULTS.rankMode) params.set("rankMode", inputs.rankMode.value);
  if (inputs.rankMode.value === "homeBy" && inputs.homeBy.value) {
    params.set("homeBy", inputs.homeBy.value);
  }
  return url;
}

function updatePreview(): void {
  updateHomeByVisibility();
  const url = buildWidgetUrl();
  urlWarning.hidden = true;
  urlWarning.textContent = "";

  if (!url) {
    urlPreview.textContent = "select a home station above";
    copyButton.disabled = true;
    testLink.setAttribute("aria-disabled", "true");
    testLink.removeAttribute("href");
    qrWrap.innerHTML = "";
    return;
  }

  const urlStr = url.toString();
  urlPreview.textContent = urlStr;
  copyButton.disabled = false;
  testLink.removeAttribute("aria-disabled");
  const testUrl = new URL(urlStr);
  testUrl.searchParams.set("replay", "fixtures/flight.igc");
  testUrl.searchParams.set("speed", "30");
  testLink.href = testUrl.toString();

  try {
    renderQrCode(qrWrap, urlStr);
  } catch {
    qrWrap.innerHTML = "";
    urlWarning.hidden = false;
    urlWarning.textContent = "URL is too long to render as a QR code; copy it manually instead.";
  }
}

copyButton.addEventListener("click", () => {
  void copyCurrentUrl();
});

async function copyCurrentUrl(): Promise<void> {
  const text = urlPreview.textContent ?? "";
  if (!text || text === "select a home station above") return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    copyStatus.textContent = "Copied.";
  } catch {
    copyStatus.textContent = "Copy failed; select and copy the URL manually.";
  }
  setTimeout(() => {
    copyStatus.textContent = "";
  }, 3000);
}

/*---- Boot ----*/

initDefaults();
updateHomeByVisibility();
updatePreview();

export {};
