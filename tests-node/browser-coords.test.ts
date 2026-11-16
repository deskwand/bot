import { describe, expect, it } from "vitest";
import {
  toFramePoint,
  toViewportPoint,
} from "../desktop/frontend/src/features/browser/coords";

describe("takeover coordinates", () => {
  it("scales a canvas click into the frame that was rendered", () => {
    // The canvas is 640x400 on screen; the frame behind it is 1280x800.
    expect(toFramePoint({ x: 320, y: 200 }, { width: 640, height: 400 }, 1280, 800)).toEqual({
      x: 640,
      y: 400,
    });
  });

  it("keeps 1:1 when the frame is full size", () => {
    expect(toViewportPoint({ x: 10, y: 20 }, { width: 1280, height: 800 })).toEqual({ x: 10, y: 20 });
  });

  it("composes into the coordinates the sandbox expects", () => {
    // A half-size canvas over a half-size frame: the corner lands on 640x400.
    const frame = toFramePoint({ x: 320, y: 200 }, { width: 640, height: 400 }, 640, 400);
    expect(toViewportPoint(frame, { width: 1280, height: 800 })).toEqual({ x: 320, y: 200 });
  });

  it("clamps a click that lands on the canvas edge", () => {
    expect(toViewportPoint({ x: 1281, y: -4 }, { width: 1280, height: 800 })).toEqual({ x: 1280, y: 0 });
  });
});
