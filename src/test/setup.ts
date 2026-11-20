import "@testing-library/jest-dom/vitest";

Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: () => {},
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

HTMLCanvasElement.prototype.getContext = (() => ({
  clearRect: () => {},
  fillRect: () => {},
  fillText: () => {},
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  stroke: () => {},
  strokeRect: () => {},
  setLineDash: () => {},
})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
