export type PreviewSection = "overview" | "simconnect" | "payload";
export type PreviewTone = "success" | "danger" | "warning" | "info";

export type PreviewScenarioKey =
    | "preflight_match"
    | "preflight_mismatch"
    | "cold_start_enroute"
    | "departed"
    | "overview_text_density"
    | "payload_busy"
    | "simconnect_error";

export type PreviewOverviewCardKey = "airport" | "aircraft" | "payload";

export interface PreviewStatusData {
    simconnect_connected: boolean;
    current_aircraft: string;
    current_airport: string;
    airport_match?: boolean;
    aircraft_match?: boolean;
    payload_match?: boolean;
    flight_state?: string;
    flight_progress?: string[];
    parked_label?: string;
    sim_utc_hour?: number | null;
    sim_utc_minute?: number | null;
    active_sim_state_label?: string;
}

export interface PreviewEditorRow {
    name: string;
    current: string;
    max: string;
    buttonLabel?: string;
}

export interface PreviewPayloadSection {
    summary: string;
    plannerPercent: number;
    plannerDetail: string;
    cargoRows: PreviewEditorRow[];
    baggageRows: PreviewEditorRow[];
    seatSummary: string;
    seatRows: PreviewEditorRow[];
    resultText: string;
    resultTone: PreviewTone;
}

export interface PreviewSimConnectSection {
    statusText: string;
    statusTone: PreviewTone;
    aircraftLine: string;
    airportLine: string;
    gameModeLine: string;
    menuLine: string;
    postLine: string;
    connectionLine: string;
}

export interface PreviewScenario {
    key: PreviewScenarioKey;
    label: string;
    description: string;
    defaultSection: PreviewSection;
    status: PreviewStatusData;
    overviewCardTextOverrides?: Partial<Record<PreviewOverviewCardKey, string>>;
    simconnect: PreviewSimConnectSection;
    payload: PreviewPayloadSection;
}

export interface PreviewRuntimeMocks {
    setScenario: (scenario: PreviewScenario) => void;
    restore: () => void;
}
