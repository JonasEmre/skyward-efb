import { buildOverviewViewModel } from "../Components/AddonStatusOverview";
import { syncOverviewCardLayout } from "../Components/OverviewCardLayout";
import "./index.scss";
import { PREVIEW_SCENARIOS } from "./PreviewScenarios";
import { installPreviewRuntimeMocks } from "./PreviewRuntime";
import {
    PreviewScenario,
    PreviewScenarioKey,
    PreviewSection,
    PreviewStatusData,
    PreviewEditorRow,
} from "./types";

const root = document.getElementById("app");

if (!root) {
    throw new Error("Preview root '#app' was not found.");
}

const previewRoot: HTMLElement = root;
const PREVIEW_CANVAS_WIDTH = 1645;
const PREVIEW_CANVAS_HEIGHT = 999;

const previewState: {
    activeScenarioKey: PreviewScenarioKey;
    activeSection: PreviewSection;
    status: PreviewStatusData;
} = {
    activeScenarioKey: "preflight_match",
    activeSection: PREVIEW_SCENARIOS.preflight_match.defaultSection,
    status: PREVIEW_SCENARIOS.preflight_match.status,
};

const runtime = installPreviewRuntimeMocks(PREVIEW_SCENARIOS[previewState.activeScenarioKey]);
let previewScaleRaf = 0;

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function getActiveScenario(): PreviewScenario {
    return PREVIEW_SCENARIOS[previewState.activeScenarioKey];
}

function renderSectionButton(label: string, section: PreviewSection): string {
    const isActive = previewState.activeSection === section;
    return `
        <button
            type="button"
            class="skyward-sidebar__button${isActive ? " skyward-sidebar__button--active" : ""}"
            data-preview-section="${section}"
        >
            ${escapeHtml(label)}
        </button>
    `;
}

function renderOverviewSection(scenario: PreviewScenario, status: PreviewStatusData): string {
    const overview = buildOverviewViewModel(status);
    const overviewCards = [
        {
            ...overview.cards.airport,
            statusText: scenario.overviewCardTextOverrides?.airport ?? overview.cards.airport.statusText,
        },
        {
            ...overview.cards.aircraft,
            statusText: scenario.overviewCardTextOverrides?.aircraft ?? overview.cards.aircraft.statusText,
        },
        {
            ...overview.cards.payload,
            statusText: scenario.overviewCardTextOverrides?.payload ?? overview.cards.payload.statusText,
        },
    ];
    const cards = overviewCards
        .map(
            (card) => `
                <div class="skyward-image-card skyward-image-card--square skyward-overview-card">
                    <img class="skyward-image-card__media" alt="" src="${escapeHtml(card.backgroundImage)}" />
                    <div class="skyward-image-card__overlay"></div>
                    <div class="skyward-image-card__content">
                        <div class="skyward-image-card__eyebrow">${escapeHtml(card.title)}</div>
                        <div class="skyward-image-card__body${card.statusText.length > 82 ? " skyward-image-card__body--compact" : ""}">${escapeHtml(card.statusText)}</div>
                    </div>
                </div>
            `,
        )
        .join("");

    return `
        <section class="skyward-section${previewState.activeSection === "overview" ? "" : " skyward-section--hidden"}">
            <div class="skyward-overview-grid${overview.showEnRoute ? " skyward-overview-grid--hidden" : ""}">
                ${cards}
            </div>

            <div class="skyward-image-card skyward-image-card--panoramic skyward-overview-enroute${overview.showEnRoute ? " skyward-overview-enroute--visible skyward-image-card--visible" : ""}">
                <img class="skyward-image-card__media" alt="" src="${escapeHtml(overview.enRouteImage)}" />
                <div class="skyward-image-card__overlay"></div>
                <div class="skyward-image-card__center-label">En Route</div>
            </div>

            <div class="skyward-meta-list">
                <div class="skyward-meta-row">${escapeHtml(overview.progressText)}</div>
                <div class="skyward-meta-row${overview.parkedText ? "" : " skyward-meta-row--hidden"}">${escapeHtml(overview.parkedText)}</div>
                <div class="skyward-meta-row">${escapeHtml(overview.simUtcText)}</div>
                <div class="skyward-meta-row">${escapeHtml(overview.simStateText)}</div>
            </div>
        </section>
    `;
}

function renderSimconnectSection(scenario: PreviewScenario): string {
    const simconnect = scenario.simconnect;
    return `
        <section class="skyward-section${previewState.activeSection === "simconnect" ? "" : " skyward-section--hidden"}">
            <div class="skyward-section__header">
                <h2 class="skyward-section__title">SimConnect</h2>
                <p class="skyward-section__subtitle">Connection, game state capture and EFB posting diagnostics.</p>
            </div>

            <div class="skyward-status-line skyward-status-line--${simconnect.statusTone}">${escapeHtml(simconnect.statusText)}</div>
            <div class="skyward-info-line">${escapeHtml(simconnect.aircraftLine)}</div>
            <div class="skyward-info-line">${escapeHtml(simconnect.airportLine)}</div>
            <div class="skyward-debug-line skyward-debug-line--warning">${escapeHtml(simconnect.gameModeLine)}</div>
            <div class="skyward-debug-line skyward-debug-line--warning">${escapeHtml(simconnect.menuLine)}</div>
            <div class="skyward-debug-line skyward-debug-line--danger">${escapeHtml(simconnect.postLine)}</div>
            <div class="skyward-debug-line skyward-debug-line--info">${escapeHtml(simconnect.connectionLine)}</div>
        </section>
    `;
}

function renderEditorRows(rows: PreviewEditorRow[]): string {
    if (rows.length === 0) {
        return `<div class="skyward-empty-state">No rows for this scenario.</div>`;
    }

    return rows
        .map((row) => {
            const buttonLabel = row.buttonLabel ?? "Set";
            return `
                <div class="skyward-editor-row">
                    <div class="skyward-editor-row__info">
                        ${escapeHtml(row.name)}  Current: ${escapeHtml(row.current)}  Max: ${escapeHtml(row.max)}
                    </div>
                    <input class="skyward-editor-input" value="${escapeHtml(row.current)}" readonly />
                    <button type="button" class="skyward-action-button skyward-action-button--blue">${escapeHtml(buttonLabel)}</button>
                </div>
            `;
        })
        .join("");
}

function renderPayloadSection(scenario: PreviewScenario): string {
    const payload = scenario.payload;
    return `
        <section class="skyward-section${previewState.activeSection === "payload" ? "" : " skyward-section--hidden"}">
            <div class="skyward-section__header">
                <h2 class="skyward-section__title">Payload</h2>
                <p class="skyward-section__subtitle">Mass and balance planning, live payload editing and aircraft export.</p>
            </div>

            <div class="skyward-payload-summary">${escapeHtml(payload.summary)}</div>

            <div class="skyward-subsection">
                <div class="skyward-subsection__title">Takeoff-safe payload planner (Atlas-like):</div>
                <div class="skyward-planner">
                    <input class="skyward-planner__slider" type="range" min="0" max="100" value="${payload.plannerPercent}" disabled />
                    <input class="skyward-editor-input" type="number" min="0" max="100" value="${payload.plannerPercent}" readonly />
                    <button type="button" class="skyward-action-button skyward-action-button--green skyward-action-button--wide">Apply TO-safe</button>
                    <div class="skyward-planner__detail">${escapeHtml(payload.plannerDetail)}</div>
                </div>
            </div>

            <div class="skyward-subsection">
                <div class="skyward-subsection__title">Cargo stations (weight lbs, with max limit):</div>
                <div class="skyward-editor-list">${renderEditorRows(payload.cargoRows)}</div>
            </div>

            <div class="skyward-subsection">
                <div class="skyward-subsection__title">Baggage stations (weight lbs, with max limit):</div>
                <div class="skyward-editor-list">${renderEditorRows(payload.baggageRows)}</div>
            </div>

            <div class="skyward-subsection">
                <div class="skyward-subsection__title">Passenger/seat stations (occupancy pax, with max seat capacity):</div>
                <div class="skyward-seat-summary">${escapeHtml(payload.seatSummary)}</div>
                <div class="skyward-editor-list">${renderEditorRows(payload.seatRows)}</div>
            </div>

            <div class="skyward-action-group">
                <button type="button" class="skyward-action-button skyward-action-button--blue">Load Cargo Preset</button>
                <button type="button" class="skyward-action-button skyward-action-button--teal">Send Plan to ATC (No Immediate Load)</button>
                <button type="button" class="skyward-action-button skyward-action-button--blue">Export Aircraft JSON</button>
            </div>

            <div class="skyward-result skyward-result--${payload.resultTone}">${escapeHtml(payload.resultText)}</div>
        </section>
    `;
}

function renderPreviewApp(): string {
    const scenario = getActiveScenario();
    const status = previewState.status;

    return `
        <div class="skyward-efb-app">
            <div class="skyward-efb-shell">
                <aside class="skyward-sidebar">
                    <div class="skyward-sidebar__brand">
                        <div class="skyward-sidebar__title">Skyward EFB</div>
                        <div class="skyward-sidebar__subtitle">Internal app sections</div>
                    </div>
                    <nav class="skyward-sidebar__nav">
                        ${renderSectionButton("Overview", "overview")}
                        ${renderSectionButton("SimConnect", "simconnect")}
                        ${renderSectionButton("Payload", "payload")}
                    </nav>
                </aside>

                <main class="skyward-content">
                    ${renderOverviewSection(scenario, status)}
                    ${renderSimconnectSection(scenario)}
                    ${renderPayloadSection(scenario)}
                </main>
            </div>
        </div>
    `;
}

function syncPreviewSurfaceScale(): void {
    const host = previewRoot.querySelector<HTMLElement>(".skyward-preview-canvas-host");
    const frame = previewRoot.querySelector<HTMLElement>(".skyward-preview-canvas-frame");
    if (!host || !frame) {
        return;
    }

    const scale = Math.min(
        host.clientWidth / PREVIEW_CANVAS_WIDTH,
        host.clientHeight / PREVIEW_CANVAS_HEIGHT,
        1,
    );
    const resolvedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

    previewRoot.style.setProperty("--skyward-preview-scale", resolvedScale.toFixed(4));
    frame.style.width = `${Math.round(PREVIEW_CANVAS_WIDTH * resolvedScale)}px`;
    frame.style.height = `${Math.round(PREVIEW_CANVAS_HEIGHT * resolvedScale)}px`;
}

function requestPreviewScaleSync(): void {
    if (previewScaleRaf !== 0) {
        window.cancelAnimationFrame(previewScaleRaf);
    }
    previewScaleRaf = window.requestAnimationFrame(() => {
        previewScaleRaf = 0;
        syncPreviewSurfaceScale();
    });
}

function renderPreviewPage(): void {
    previewRoot.innerHTML = `
        <div class="skyward-preview-page">
            <div class="skyward-preview-canvas-host">
                <div class="skyward-preview-canvas-frame">
                    <div class="skyward-preview-surface">
                        ${renderPreviewApp()}
                    </div>
                </div>
            </div>
        </div>
    `;
    syncOverviewCardLayout(previewRoot);
    requestPreviewScaleSync();
}

async function refreshMockStatus(): Promise<void> {
    const response = await fetch("/status");
    previewState.status = (await response.json()) as PreviewStatusData;
    renderPreviewPage();
}

previewRoot.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) {
        return;
    }

    const sectionButton = target.closest<HTMLElement>("[data-preview-section]");
    if (sectionButton) {
        const nextSection = sectionButton.dataset.previewSection as PreviewSection | undefined;
        if (!nextSection) {
            return;
        }
        previewState.activeSection = nextSection;
        renderPreviewPage();
    }
});

window.addEventListener("beforeunload", () => {
    runtime.restore();
});

window.addEventListener("resize", requestPreviewScaleSync);

void refreshMockStatus();
