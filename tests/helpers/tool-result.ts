import type { ToolExecutionResult, ToolPark } from "@earendil-works/pi-durable";

/**
 * A tool call's result. A park means the call would suspend until a signal or
 * another task; none of these tests drives that, so a park is a failure here
 * rather than something to read as a result.
 */
export function toolResult(
  result: ToolExecutionResult | ToolPark,
): ToolExecutionResult {
  if ("sleep" in result || "wait" in result) {
    throw new Error("tool call parked; this test expects a result");
  }
  return result;
}
