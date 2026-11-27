interface Bounds { x: number; y: number; width: number; height: number }
interface MovableWindow {
  isDestroyed(): boolean; isVisible(): boolean; isMinimized(): boolean;
  getBounds(): Bounds; setBounds(bounds: Bounds, animate?: boolean): void;
}

/** Keep requested logical size separate from DPI-rounded native bounds. */
export function createWindowMover() {
  let size: { width: number; height: number; actualWidth: number; actualHeight: number } | null = null;
  return (win: MovableWindow | null, areas: Bounds[], dx: number, dy: number): void => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return;
    const bounds = win.getBounds();
    const requested = size && bounds.width === size.actualWidth && bounds.height === size.actualHeight ? size : bounds;
    const minX = Math.min(...areas.map((area) => area.x));
    const minY = Math.min(...areas.map((area) => area.y));
    const maxX = Math.max(minX, Math.max(...areas.map((area) => area.x + area.width)) - bounds.width);
    const maxY = Math.max(minY, Math.max(...areas.map((area) => area.y + area.height)) - bounds.height);
    const x = Math.max(minX, Math.min(maxX, bounds.x + dx));
    const y = Math.max(minY, Math.min(maxY, bounds.y + dy));
    if (x === bounds.x && y === bounds.y) return;
    win.setBounds({ x, y, width: requested.width, height: requested.height }, false);
    const actual = win.getBounds();
    size = { width: requested.width, height: requested.height, actualWidth: actual.width, actualHeight: actual.height };
  };
}
