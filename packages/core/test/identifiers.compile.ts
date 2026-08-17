import { createMessageId, createPlacementId } from "../src/index";

const messageId = createMessageId("message-1");
const placementId = createPlacementId("placement-1");
const acceptsMessageId = (value: typeof messageId): typeof messageId => value;

acceptsMessageId(messageId);
// @ts-expect-error Namespace identifiers are intentionally not assignable.
acceptsMessageId(placementId);
