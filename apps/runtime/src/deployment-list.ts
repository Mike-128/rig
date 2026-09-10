import { z } from "zod";

const Deployment = z.object({
  name: z.string().trim().min(1),
  properties: z.object({
    model: z.object({ format: z.string(), name: z.string() }),
    capabilities: z.object({ chatCompletion: z.union([z.string(), z.boolean()]).optional() }).passthrough().optional(),
    provisioningState: z.string().optional(),
  }),
});

/** Normalize gateway inventory in the credential-owning proxy, before SDK pagination. */
export function deploymentList(payload: unknown) {
  const wrapper = z.object({ value: z.array(z.unknown()).optional(), data: z.array(z.unknown()).optional(), nextLink: z.unknown().optional() }).safeParse(payload);
  if (wrapper.success && wrapper.data.nextLink) {
    throw new Error("Deployment inventory has a nextLink. Paginated deployment inventories are not yet supported; no partial inventory was imported.");
  }
  const rows = Array.isArray(payload) ? payload : wrapper.success ? wrapper.data.value ?? wrapper.data.data : undefined;
  if (!rows) throw new Error("Expected a deployment array or an object containing value/data arrays. Check the listing endpoint and response format.");
  const parsed = z.array(Deployment).safeParse(rows);
  if (!parsed.success) throw new Error("Deployment entries require name and properties.model metadata. An access/entitlement list may not contain deployment routing information.");
  const ids = new Set<string>();
  for (const row of parsed.data) {
    const props = row.properties;
    if (props.model.format.toLowerCase() !== "openai") continue;
    if (props.provisioningState && props.provisioningState !== "Succeeded") continue;
    const chat = props.capabilities?.chatCompletion;
    if (chat !== true && chat !== "true") continue;
    ids.add(row.name);
  }
  if (rows.length && !ids.size) throw new Error("Inventory returned deployments, but none were OpenAI chat-capable deployments in a successful state. Check capabilities and the selected endpoint.");
  return { object: "list", data: [...ids].map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" })) };
}
