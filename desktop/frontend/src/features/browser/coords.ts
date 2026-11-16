export type Point = { x: number; y: number };
export type Size = { width: number; height: number };

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)));
}

/** Canvas pixels -> the frame's own pixel space. */
export function toFramePoint(point: Point, canvas: Size, frameW: number, frameH: number): Point {
  return {
    x: clamp((point.x * frameW) / canvas.width, frameW),
    y: clamp((point.y * frameH) / canvas.height, frameH),
  };
}

/** Frame pixels -> the 1280x800 viewport the sandbox drives. */
export function toViewportPoint(point: Point, viewport: Size): Point {
  return { x: clamp(point.x, viewport.width), y: clamp(point.y, viewport.height) };
}
