import type { PaywallTracker } from "../src/paywall";

type PresentErrorReason =
  | "unknown-moment" | "already-presenting" | "parse-error" | "render-error"
  | "host-never-presented" | "paywall-disappeared" | "unknown-custom-screen";
interface PaywallPresentationInfo {
  moment: string; paywallId: string; audienceId: string | null; renderMode: "elements" | "custom";
  billing: "store" | "stripe"; surface: "present" | "paywall_step"; variantKey?: string; deploymentId?: string;
  onboardingRun?: { runId: string; stepKey: string };
}
interface PaywallTransactionInfo { originalTransactionIdentifier?: string; purchaseToken?: string; productId?: string; restored?: boolean }
interface PaywallPresentationEnd { status: "purchased" | "dismissed" | "cancelled" | "error"; reason?: PresentErrorReason; transaction?: PaywallTransactionInfo }
interface PaywallPresentationHandle { shown(): void; end(outcome: PaywallPresentationEnd): void }
interface HostPaywallObserver { start(info: PaywallPresentationInfo): PaywallPresentationHandle | void }

type Assert<T extends true> = T;
export type Checks = [Assert<PaywallTracker extends HostPaywallObserver ? true : false>];
// Usage form: what a host writes.
export const asObserver = (t: PaywallTracker): HostPaywallObserver => t;
