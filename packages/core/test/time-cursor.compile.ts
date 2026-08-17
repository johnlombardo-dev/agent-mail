import { createMonotonicSequence, createStreamingOffset } from "../src/time-cursor";

const sequence = createMonotonicSequence(1);
const offset = createStreamingOffset(1);

// @ts-expect-error A stream position is not a monotonic event sequence.
const sequenceFromOffset = sequence satisfies typeof offset;
// @ts-expect-error A monotonic event sequence is not a stream position.
const offsetFromSequence = offset satisfies typeof sequence;

void sequenceFromOffset;
void offsetFromSequence;
