// Lock 2 of 2 on drift between the paywall presentation schema and its public
// types. Checked by `npm run type:check:tests`. Nothing here runs.
import type { PaywallPresentationSnapshot } from "../src/paywall/contract";
import type { PresentationFromSchema } from "./paywall-schema-types.generated";

type Normalize<T> = T extends readonly (infer U)[]
  ? Normalize<U>[]
  : T extends object
    ? { [K in keyof T]: Normalize<T[K]> }
    : T;
type Equals<A, B> = (<X>() => X extends A ? 1 : 2) extends (<X>() => X extends B ? 1 : 2) ? true : false;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type Same<A, B> = Equals<Normalize<A>, Normalize<B>>;
type DropField<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Checks = [
  Assert<Equals<IsAny<PaywallPresentationSnapshot>, false>>,
  Assert<Equals<IsAny<PresentationFromSchema>, false>>,
  // Negative control: dropping an optional field is noticed.
  Assert<Equals<Same<DropField<PaywallPresentationSnapshot, "onboarding_run">, PresentationFromSchema>, false>>,
  // The schema is looser than the discriminated union (status and outcome are
  // independent there; section 4 ties them), so the lock is one-way:
  // every public snapshot is a schema snapshot.
  Assert<PaywallPresentationSnapshot extends PresentationFromSchema ? true : false>,
];
