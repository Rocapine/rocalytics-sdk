// Lock 2 of 2 on drift between the JSON Schema and the public types (lock 1 is
// test/schema-types.test.ts). Checked by `tsc -p tsconfig.test.json`
// (`npm run type:check:tests`): any line below that does not hold is a compile
// error. Nothing here runs.
import type {
  Answer,
  OnboardingRunSnapshot,
  StepEntry,
} from "../src/onboarding";
import type { SnapshotFromSchema } from "./schema-types.generated";

// Flattens interfaces and intersections into plain object types, distributing
// over unions and recursing into arrays, so two spellings of the same shape
// compare equal and any difference in a field, its optionality or its type
// does not.
type Normalize<T> = T extends readonly (infer U)[]
  ? Normalize<U>[]
  : T extends object
    ? { [K in keyof T]: Normalize<T[K]> }
    : T;

// Strict equality: mutual assignability is not enough, because an object with
// one optional field fewer is still assignable both ways.
type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type Same<A, B> = Equals<Normalize<A>, Normalize<B>>;

type DropField<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Checks = [
  // The public snapshot type is exactly what the schema describes.
  Assert<Same<OnboardingRunSnapshot, SnapshotFromSchema>>,

  // Neither side is `any`, which would make the equality above vacuous.
  Assert<Equals<IsAny<OnboardingRunSnapshot>, false>>,
  Assert<Equals<IsAny<SnapshotFromSchema>, false>>,
  Assert<Equals<IsAny<StepEntry>, false>>,

  // Negative controls: the comparison does notice a drift.
  // ...an optional field dropped,
  Assert<Equals<Same<DropField<OnboardingRunSnapshot, "truncated">, SnapshotFromSchema>, false>>,
  // ...a field added,
  Assert<Equals<Same<OnboardingRunSnapshot & { country?: string }, SnapshotFromSchema>, false>>,
  // ...a required field made optional,
  Assert<Equals<Same<DropField<OnboardingRunSnapshot, "seq"> & { seq?: number }, SnapshotFromSchema>, false>>,
  // ...a nested change (an answer kind added).
  Assert<Equals<Same<Answer | { question_key: string; kind: "rating"; value: number }, Answer>, false>>,
];
