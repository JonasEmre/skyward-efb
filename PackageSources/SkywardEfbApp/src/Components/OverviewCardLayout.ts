export function syncOverviewCardLayout(root: ParentNode): void {
    const squareCards = root.querySelectorAll<HTMLElement>(".skyward-overview-card");
    for (const card of squareCards) {
        const width = card.clientWidth;
        if (width > 0) {
            card.style.height = `${Math.round(width)}px`;
        }
    }

    const panoramicCards = root.querySelectorAll<HTMLElement>(".skyward-overview-enroute");
    for (const card of panoramicCards) {
        const width = card.clientWidth;
        if (width > 0) {
            card.style.height = `${Math.round(width / 3)}px`;
        }
    }
}
