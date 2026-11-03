/**
 * Bridge delivery tool for unattended Pi runs.
 *
 * This file is loaded by the Pi CLI through `--extension`. It is intentionally
 * outside `src/**` so the host project does not need Pi's package types at
 * compile time.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const deliveryTool = defineTool({
  name: "deliver_result",
  label: "Deliver Result",
  description:
    "Submit the final structured result to the local bridge. Call exactly once when the task is complete or blocked. Do not call this before all work is finished.",
  parameters: Type.Object({
    status: Type.Union([Type.Literal("COMPLETED"), Type.Literal("BLOCKED")]),
    summary: Type.String({
      description: "Concise summary of what was done or why the task is blocked.",
    }),
    modified_files: Type.Array(Type.String(), {
      description: "Files created or modified by this task. Use an empty array if none.",
    }),
    verification_passed: Type.Boolean({
      description:
        "True when relevant checks passed, or when no automated verification is applicable.",
    }),
    notes: Type.Optional(
      Type.String({
        description: "Extra information a human needs, such as missing configuration.",
      }),
    ),
  }),

  async execute(_toolCallId, params) {
    const taskId = process.env.BRIDGE_TASK_ID;
    const url = process.env.BRIDGE_DELIVERY_URL;
    const token = process.env.BRIDGE_INTERNAL_TOKEN;

    if (!taskId || !url || !token) {
      throw new Error(
        "Bridge delivery environment is incomplete (BRIDGE_TASK_ID, BRIDGE_DELIVERY_URL, BRIDGE_INTERNAL_TOKEN)",
      );
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        task_id: taskId,
        status: params.status,
        summary: params.summary,
        modified_files: params.modified_files,
        verification_passed: params.verification_passed,
        notes: params.notes,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const bodyText = await response.text().catch(() => "");
    if (!response.ok) {
      throw new Error(
        `Bridge delivery failed with HTTP ${response.status}: ${bodyText.slice(0, 500)}`,
      );
    }

    let resultStatus = "delivered";
    if (bodyText.trim()) {
      try {
        const parsed = JSON.parse(bodyText) as { status?: string };
        if (parsed.status) resultStatus = parsed.status;
      } catch {
        // The HTTP status is sufficient when the bridge returns non-JSON content.
      }
    }

    return {
      content: [{ type: "text", text: `Delivery accepted: ${resultStatus}` }],
      details: undefined,
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(deliveryTool);
}
