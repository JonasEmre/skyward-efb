/**
 * Full MSFS airport export flow kept as a standalone reusable module.
 * The active map-side caller can import this class directly or through `db_pull.ts`.
 */

import {
    AirportClass,
    AirportClassMask,
    AirportFacility,
    AirportFacilityDataFlags,
    AirportPrivateType,
    AirspaceType,
    BitFlags,
    FacilityFrequencyType,
    FacilityLoader,
    FacilitySearchType,
    FacilityType,
    GpsBoolean,
    ICAO,
    IcaoValue,
    NearestAirportSearchSession,
    RunwayLightingType,
    RunwaySurfaceType,
    UnitType,
} from "@microsoft/msfs-sdk";

declare const Utils: {
    Translate(text: string): string;
};

interface WorldAirportExportCell {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
    depth: number;
}

interface SerializedWorldAirport {
    icao: string;
    icao_raw: string;
    ident: string;
    iata: string;
    name: string;
    name_token: string;
    city: string;
    city_token: string;
    region_code: string;
    lat: number;
    lon: number;
    altitude_m: number;
    magvar: number;
    airport_class: number;
    airport_class_name: string;
    airport_private_type: number;
    airport_private_type_name: string;
    towered: boolean;
    radar_coverage: number;
    radar_coverage_name: string;
    airspace_type: number;
    airspace_type_name: string;
    best_approach: string;
    fuel_1: string;
    fuel_2: string;
    transition_alt_m: number;
    transition_level_m: number;
    is_heliport_only: boolean;
    has_runways: boolean;
    has_approaches: boolean;
    frequencies: {
        name: string;
        type: number;
        type_name: string;
        mhz: number;
        bcd16: number;
    }[];
    runways: {
        designation: string;
        direction: number;
        length_m: number;
        width_m: number;
        surface: number;
        surface_name: string;
        lighting: number;
        lighting_name: string;
        designator_primary: number;
        designator_secondary: number;
        primary_threshold_length_m: number;
        secondary_threshold_length_m: number;
    }[];
    counts: {
        frequencies: number;
        runways: number;
        departures: number;
        arrivals: number;
        approaches: number;
        holding_patterns: number;
    };
    translation_debug?: {
        name_status: string;
        city_status: string;
        name_codepoints: string[];
        city_codepoints: string[];
    };
}

export class MsfsAirportDbPullDebug {
    private static readonly CELL_STEP_DEG = 20;
    private static readonly MIN_CELL_SIZE_DEG = 2.5;
    private static readonly MAX_RESULTS_PER_CELL = 400;
    private static readonly CELLS_PER_BATCH = 4;
    private static readonly BATCH_INTERVAL_MS = 1_000;
    private static readonly SERVER_BASE_URL = "http://127.0.0.1:5000";

    private exportInProgress = false;
    private batchInFlight = false;
    private batchTimer?: number;
    private queue: WorldAirportExportCell[] = [];
    private readonly seenIcaos = new Set<string>();
    private sessionId = "";
    private startedAtMs = 0;
    private processedCells = 0;
    private batchCount = 0;
    private maxQueuedCells = 0;
    private hasValidGpsPosition = false;

    constructor(private readonly facilityLoader: FacilityLoader) {}

    public notifyGpsPosition(lat: number, lon: number): void {
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            return;
        }
        this.hasValidGpsPosition = true;
    }

    public startManualExport(): "started" | "waiting_gps" | "busy" {
        if (!this.hasValidGpsPosition) {
            return "waiting_gps";
        }
        if (this.exportInProgress) {
            return "busy";
        }

        void this.startWorldExport();
        return "started";
    }

    public destroy(): void {
        if (this.batchTimer !== undefined) {
            window.clearInterval(this.batchTimer);
            this.batchTimer = undefined;
        }
        this.exportInProgress = false;
        this.batchInFlight = false;
        this.queue = [];
        this.seenIcaos.clear();
    }

    private async startWorldExport(): Promise<void> {
        if (this.exportInProgress) {
            return;
        }

        this.exportInProgress = true;
        this.sessionId = `msfs-airports-v2-${Date.now()}`;
        this.startedAtMs = Date.now();
        this.processedCells = 0;
        this.batchCount = 0;
        this.queue = this.createInitialWorldGrid();
        this.maxQueuedCells = this.queue.length;
        this.seenIcaos.clear();

        await this.facilityLoader.awaitInitialization();
        await this.postJson("/debug/msfs-airports-export-v2/start", {
            session_id: this.sessionId,
            meta: {
                exported_from: "SkywardOverviewMap",
                trigger_mode: "manual_button",
                schema: "msfs_airports_v2_debug",
                cell_step_deg: MsfsAirportDbPullDebug.CELL_STEP_DEG,
                min_cell_size_deg: MsfsAirportDbPullDebug.MIN_CELL_SIZE_DEG,
                max_results_per_cell: MsfsAirportDbPullDebug.MAX_RESULTS_PER_CELL,
                batch_interval_ms: MsfsAirportDbPullDebug.BATCH_INTERVAL_MS,
                fields: [
                    "icao",
                    "icao_raw",
                    "name",
                    "name_token",
                    "city",
                    "city_token",
                    "translation_debug",
                ],
            },
        });

        this.batchTimer = window.setInterval(() => {
            void this.processNextBatch();
        }, MsfsAirportDbPullDebug.BATCH_INTERVAL_MS);

        await this.processNextBatch();
    }

    private async processNextBatch(): Promise<void> {
        if (!this.exportInProgress || this.batchInFlight) {
            return;
        }

        if (this.queue.length === 0) {
            await this.finishWorldExport();
            return;
        }

        this.batchInFlight = true;
        const airports: SerializedWorldAirport[] = [];

        try {
            const batchCells = this.queue.splice(0, MsfsAirportDbPullDebug.CELLS_PER_BATCH);

            for (const cell of batchCells) {
                const facilities = await this.searchCellAirports(cell);
                if (facilities.length >= MsfsAirportDbPullDebug.MAX_RESULTS_PER_CELL && this.canSubdivideCell(cell)) {
                    this.queue.unshift(...this.subdivideCell(cell));
                    continue;
                }

                for (const facility of facilities) {
                    const icao = this.cleanIcao(facility.icao);
                    if (!icao || this.seenIcaos.has(icao)) {
                        continue;
                    }

                    this.seenIcaos.add(icao);
                    airports.push(this.serializeAirport(facility));
                }

                this.processedCells += 1;
            }

            this.batchCount += 1;
            if (airports.length > 0 || this.queue.length === 0) {
                await this.postJson("/debug/msfs-airports-export-v2/batch", {
                    session_id: this.sessionId,
                    airports,
                    progress: this.buildProgressSnapshot(),
                });
            }
        } catch (error) {
            console.error("MSFS airport v2 export batch failed.", error);
            await this.finishWorldExport({
                status: "failed",
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        } finally {
            this.batchInFlight = false;
        }

        if (this.queue.length === 0) {
            await this.finishWorldExport();
        }
    }

    private async finishWorldExport(extraSummary?: Record<string, unknown>): Promise<void> {
        if (!this.exportInProgress) {
            return;
        }

        this.exportInProgress = false;
        if (this.batchTimer !== undefined) {
            window.clearInterval(this.batchTimer);
            this.batchTimer = undefined;
        }

        await this.postJson("/debug/msfs-airports-export-v2/finish", {
            session_id: this.sessionId,
            summary: {
                status: extraSummary?.status ?? "complete",
                duration_ms: Date.now() - this.startedAtMs,
                processed_cells: this.processedCells,
                remaining_cells: this.queue.length,
                total_batches: this.batchCount,
                unique_airports: this.seenIcaos.size,
                ...extraSummary,
            },
        });

        this.queue = [];
    }

    private async searchCellAirports(cell: WorldAirportExportCell): Promise<AirportFacility[]> {
        const centerLat = (cell.minLat + cell.maxLat) / 2;
        const centerLon = (cell.minLon + cell.maxLon) / 2;
        const radiusMeters = UnitType.NMILE.convertTo(this.getCellRadiusNm(cell), UnitType.METER);
        const searchSession = await this.facilityLoader.startNearestSearchSessionWithIcaoStructs(FacilitySearchType.Airport);

        searchSession.setAirportFilter(
            true,
            BitFlags.union(
                AirportClassMask.HardSurface,
                AirportClassMask.SoftSurface,
                AirportClassMask.AllWater,
                AirportClassMask.HeliportOnly,
                AirportClassMask.Private,
            ),
        );
        searchSession.setExtendedAirportFilters(
            NearestAirportSearchSession.Defaults.SurfaceTypeMask,
            NearestAirportSearchSession.Defaults.ApproachTypeMask,
            NearestAirportSearchSession.Defaults.ToweredMask,
            0,
        );

        const results = await searchSession.searchNearest(
            centerLat,
            centerLon,
            radiusMeters,
            MsfsAirportDbPullDebug.MAX_RESULTS_PER_CELL,
        );

        if (results.added.length === 0) {
            return [];
        }

        const facilities = await this.facilityLoader.getFacilitiesOfType(
            FacilityType.Airport,
            results.added as readonly IcaoValue[],
            AirportFacilityDataFlags.All,
        );

        return facilities.filter((facility): facility is AirportFacility => facility !== null);
    }

    private createInitialWorldGrid(): WorldAirportExportCell[] {
        const cells: WorldAirportExportCell[] = [];
        const step = MsfsAirportDbPullDebug.CELL_STEP_DEG;
        for (let minLat = -90; minLat < 90; minLat += step) {
            const maxLat = Math.min(90, minLat + step);
            for (let minLon = -180; minLon < 180; minLon += step) {
                const maxLon = Math.min(180, minLon + step);
                cells.push({ minLat, maxLat, minLon, maxLon, depth: 0 });
            }
        }

        return cells;
    }

    private canSubdivideCell(cell: WorldAirportExportCell): boolean {
        return (
            cell.maxLat - cell.minLat > MsfsAirportDbPullDebug.MIN_CELL_SIZE_DEG
            && cell.maxLon - cell.minLon > MsfsAirportDbPullDebug.MIN_CELL_SIZE_DEG
        );
    }

    private subdivideCell(cell: WorldAirportExportCell): WorldAirportExportCell[] {
        const midLat = (cell.minLat + cell.maxLat) / 2;
        const midLon = (cell.minLon + cell.maxLon) / 2;

        return [
            { minLat: cell.minLat, maxLat: midLat, minLon: cell.minLon, maxLon: midLon, depth: cell.depth + 1 },
            { minLat: cell.minLat, maxLat: midLat, minLon: midLon, maxLon: cell.maxLon, depth: cell.depth + 1 },
            { minLat: midLat, maxLat: cell.maxLat, minLon: cell.minLon, maxLon: midLon, depth: cell.depth + 1 },
            { minLat: midLat, maxLat: cell.maxLat, minLon: midLon, maxLon: cell.maxLon, depth: cell.depth + 1 },
        ];
    }

    private getCellRadiusNm(cell: WorldAirportExportCell): number {
        const centerLat = (cell.minLat + cell.maxLat) / 2;
        const latRadiusNm = ((cell.maxLat - cell.minLat) / 2) * 60;
        const lonRadiusNm = ((cell.maxLon - cell.minLon) / 2) * 60 * Math.max(Math.cos(centerLat * Math.PI / 180), 0.1);

        return Math.max(30, Math.hypot(latRadiusNm, lonRadiusNm) * 1.08);
    }

    private serializeAirport(facility: AirportFacility): SerializedWorldAirport {
        const ident = ICAO.getIdent(facility.icao);
        const cleanIcao = this.cleanIcao(facility.icao);
        const translatedName = this.translateFacilityText(facility.name);
        const translatedCity = this.translateFacilityCity(facility.city);
        const nameStatus = this.getTranslationStatus(translatedName);
        const cityStatus = this.getTranslationStatus(translatedCity);

        return {
            icao: cleanIcao || ident,
            icao_raw: facility.icao,
            ident,
            iata: facility.iata ?? "",
            name: translatedName,
            name_token: facility.name ?? "",
            city: translatedCity,
            city_token: facility.city ?? "",
            region_code: facility.region ?? "",
            lat: facility.lat,
            lon: facility.lon,
            altitude_m: facility.altitude,
            magvar: facility.magvar,
            airport_class: facility.airportClass,
            airport_class_name: this.getAirportClassName(facility.airportClass),
            airport_private_type: facility.airportPrivateType,
            airport_private_type_name: this.getAirportPrivateTypeName(facility.airportPrivateType),
            towered: facility.towered,
            radar_coverage: facility.radarCoverage,
            radar_coverage_name: this.getGpsBooleanName(facility.radarCoverage),
            airspace_type: facility.airspaceType,
            airspace_type_name: this.getAirspaceTypeName(facility.airspaceType),
            best_approach: facility.bestApproach ?? "",
            fuel_1: facility.fuel1 ?? "",
            fuel_2: facility.fuel2 ?? "",
            transition_alt_m: facility.transitionAlt ?? 0,
            transition_level_m: facility.transitionLevel ?? 0,
            is_heliport_only: facility.airportClass === AirportClass.HeliportOnly,
            has_runways: facility.runways.length > 0,
            has_approaches: facility.approaches.length > 0,
            frequencies: facility.frequencies.map(frequency => ({
                name: this.translateFacilityText(frequency.name ?? ""),
                type: frequency.type,
                type_name: this.getFacilityFrequencyTypeName(frequency.type),
                mhz: frequency.freqMHz,
                bcd16: frequency.freqBCD16,
            })),
            runways: facility.runways.map(runway => ({
                designation: runway.designation,
                direction: runway.direction,
                length_m: runway.length,
                width_m: runway.width,
                surface: runway.surface,
                surface_name: this.getRunwaySurfaceTypeName(runway.surface),
                lighting: runway.lighting,
                lighting_name: this.getRunwayLightingTypeName(runway.lighting),
                designator_primary: runway.designatorCharPrimary,
                designator_secondary: runway.designatorCharSecondary,
                primary_threshold_length_m: runway.primaryThresholdLength,
                secondary_threshold_length_m: runway.secondaryThresholdLength,
            })),
            counts: {
                frequencies: facility.frequencies.length,
                runways: facility.runways.length,
                departures: facility.departures.length,
                arrivals: facility.arrivals.length,
                approaches: facility.approaches.length,
                holding_patterns: facility.holdingPatterns.length,
            },
            translation_debug: nameStatus !== "ascii" || cityStatus !== "ascii"
                ? {
                    name_status: nameStatus,
                    city_status: cityStatus,
                    name_codepoints: this.toCodePoints(translatedName),
                    city_codepoints: this.toCodePoints(translatedCity),
                }
                : undefined,
        };
    }

    private translateFacilityText(rawText: string): string {
        const text = String(rawText ?? "").trim();
        if (!text) {
            return "";
        }

        return text.startsWith("@") || text.startsWith("TT")
            ? Utils.Translate(text)
            : text;
    }

    private translateFacilityCity(rawCity: string): string {
        const city = String(rawCity ?? "").trim();
        if (!city) {
            return "";
        }

        return city
            .split(",")
            .map(part => this.translateFacilityText(part.trim()))
            .filter(Boolean)
            .join(", ");
    }

    private cleanIcao(rawIcao: string): string {
        const ident = ICAO.getIdent(rawIcao);
        return ident ? ident.trim() : "";
    }

    private getTranslationStatus(text: string): string {
        if (!text) {
            return "empty";
        }
        if (text.includes("?")) {
            return "replacement";
        }
        if (/[^\u0000-\u007F]/.test(text)) {
            return "unicode";
        }
        return "ascii";
    }

    private toCodePoints(text: string): string[] {
        return Array.from(text).map(char => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
    }

    private buildProgressSnapshot(): Record<string, number> {
        this.maxQueuedCells = Math.max(this.maxQueuedCells, this.processedCells + this.queue.length);

        return {
            batch_index: this.batchCount,
            processed_cells: this.processedCells,
            queued_cells: this.queue.length,
            total_known_cells: this.maxQueuedCells,
            unique_airports: this.seenIcaos.size,
        };
    }

    private async postJson(path: string, payload: Record<string, unknown>): Promise<void> {
        const response = await fetch(`${MsfsAirportDbPullDebug.SERVER_BASE_URL}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(`Airport export request failed: ${response.status} ${response.statusText}`);
        }
    }

    private getAirportClassName(value: number): string {
        switch (value) {
            case AirportClass.None:
                return "None";
            case AirportClass.HardSurface:
                return "HardSurface";
            case AirportClass.SoftSurface:
                return "SoftSurface";
            case AirportClass.AllWater:
                return "AllWater";
            case AirportClass.HeliportOnly:
                return "HeliportOnly";
            case AirportClass.Private:
                return "Private";
            default:
                return "Unknown";
        }
    }

    private getAirportPrivateTypeName(value: number): string {
        switch (value) {
            case AirportPrivateType.Uknown:
                return "Unknown";
            case AirportPrivateType.Public:
                return "Public";
            case AirportPrivateType.Military:
                return "Military";
            case AirportPrivateType.Private:
                return "Private";
            default:
                return "Unknown";
        }
    }

    private getGpsBooleanName(value: number): string {
        switch (value) {
            case GpsBoolean.Unknown:
                return "Unknown";
            case GpsBoolean.No:
                return "No";
            case GpsBoolean.Yes:
                return "Yes";
            default:
                return "Unknown";
        }
    }

    private getAirspaceTypeName(value: number): string {
        switch (value) {
            case AirspaceType.None:
                return "None";
            case AirspaceType.Center:
                return "Center";
            case AirspaceType.ClassA:
                return "ClassA";
            case AirspaceType.ClassB:
                return "ClassB";
            case AirspaceType.ClassC:
                return "ClassC";
            case AirspaceType.ClassD:
                return "ClassD";
            case AirspaceType.ClassE:
                return "ClassE";
            case AirspaceType.ClassF:
                return "ClassF";
            case AirspaceType.ClassG:
                return "ClassG";
            case AirspaceType.Tower:
                return "Tower";
            case AirspaceType.Clearance:
                return "Clearance";
            case AirspaceType.Ground:
                return "Ground";
            case AirspaceType.Departure:
                return "Departure";
            case AirspaceType.Approach:
                return "Approach";
            case AirspaceType.MOA:
                return "MOA";
            case AirspaceType.Restricted:
                return "Restricted";
            case AirspaceType.Prohibited:
                return "Prohibited";
            case AirspaceType.Warning:
                return "Warning";
            case AirspaceType.Alert:
                return "Alert";
            case AirspaceType.Danger:
                return "Danger";
            case AirspaceType.Nationalpark:
                return "Nationalpark";
            case AirspaceType.ModeC:
                return "ModeC";
            case AirspaceType.Radar:
                return "Radar";
            case AirspaceType.Training:
                return "Training";
            default:
                return "Unknown";
        }
    }

    private getFacilityFrequencyTypeName(value: number): string {
        switch (value) {
            case FacilityFrequencyType.None:
                return "None";
            case FacilityFrequencyType.ATIS:
                return "ATIS";
            case FacilityFrequencyType.Multicom:
                return "Multicom";
            case FacilityFrequencyType.Unicom:
                return "Unicom";
            case FacilityFrequencyType.CTAF:
                return "CTAF";
            case FacilityFrequencyType.Ground:
                return "Ground";
            case FacilityFrequencyType.Tower:
                return "Tower";
            case FacilityFrequencyType.Clearance:
                return "Clearance";
            case FacilityFrequencyType.Approach:
                return "Approach";
            case FacilityFrequencyType.Departure:
                return "Departure";
            case FacilityFrequencyType.Center:
                return "Center";
            case FacilityFrequencyType.FSS:
                return "FSS";
            case FacilityFrequencyType.AWOS:
                return "AWOS";
            case FacilityFrequencyType.ASOS:
                return "ASOS";
            case FacilityFrequencyType.CPT:
                return "CPT";
            case FacilityFrequencyType.GCO:
                return "GCO";
            default:
                return "Unknown";
        }
    }

    private getRunwaySurfaceTypeName(value: number): string {
        switch (value) {
            case RunwaySurfaceType.Concrete:
                return "Concrete";
            case RunwaySurfaceType.Grass:
                return "Grass";
            case RunwaySurfaceType.WaterFSX:
                return "WaterFSX";
            case RunwaySurfaceType.GrassBumpy:
                return "GrassBumpy";
            case RunwaySurfaceType.Asphalt:
                return "Asphalt";
            case RunwaySurfaceType.ShortGrass:
                return "ShortGrass";
            case RunwaySurfaceType.LongGrass:
                return "LongGrass";
            case RunwaySurfaceType.HardTurf:
                return "HardTurf";
            case RunwaySurfaceType.Snow:
                return "Snow";
            case RunwaySurfaceType.Ice:
                return "Ice";
            case RunwaySurfaceType.Urban:
                return "Urban";
            case RunwaySurfaceType.Forest:
                return "Forest";
            case RunwaySurfaceType.Dirt:
                return "Dirt";
            case RunwaySurfaceType.Coral:
                return "Coral";
            case RunwaySurfaceType.Gravel:
                return "Gravel";
            case RunwaySurfaceType.OilTreated:
                return "OilTreated";
            case RunwaySurfaceType.SteelMats:
                return "SteelMats";
            case RunwaySurfaceType.Bituminous:
                return "Bituminous";
            case RunwaySurfaceType.Brick:
                return "Brick";
            case RunwaySurfaceType.Macadam:
                return "Macadam";
            case RunwaySurfaceType.Planks:
                return "Planks";
            case RunwaySurfaceType.Sand:
                return "Sand";
            case RunwaySurfaceType.Shale:
                return "Shale";
            case RunwaySurfaceType.Tarmac:
                return "Tarmac";
            case RunwaySurfaceType.WrightFlyerTrack:
                return "WrightFlyerTrack";
            case RunwaySurfaceType.Ocean:
                return "Ocean";
            case RunwaySurfaceType.Water:
                return "Water";
            case RunwaySurfaceType.Pond:
                return "Pond";
            case RunwaySurfaceType.Lake:
                return "Lake";
            case RunwaySurfaceType.River:
                return "River";
            case RunwaySurfaceType.WasteWater:
                return "WasteWater";
            case RunwaySurfaceType.Paint:
                return "Paint";
            default:
                return "Unknown";
        }
    }

    private getRunwayLightingTypeName(value: number): string {
        switch (value) {
            case RunwayLightingType.Unknown:
                return "Unknown";
            case RunwayLightingType.None:
                return "None";
            case RunwayLightingType.PartTime:
                return "PartTime";
            case RunwayLightingType.FullTime:
                return "FullTime";
            case RunwayLightingType.Frequency:
                return "Frequency";
            default:
                return "Unknown";
        }
    }
}
