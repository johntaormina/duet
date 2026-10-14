import type { OfferedFinding } from "@duet/session";

export interface FindingsNode {
  label: string;
  kind: "cohort" | "severity" | "finding";
  children: FindingsNode[];
  finding?: OfferedFinding;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "nit"];

/** The findings tree: cohort, then severity, then each finding the session offers. */
// @spec EXT-VIEW-006
export function buildFindingsTree(findings: OfferedFinding[]): FindingsNode[] {
  const cohorts = [...new Set(findings.map((f) => f.cohort))].sort((a, b) => (a === "other" ? 1 : b === "other" ? -1 : a.localeCompare(b)));
  return cohorts.map((cohort) => {
    const inCohort = findings.filter((f) => f.cohort === cohort);
    const severities = SEVERITY_ORDER.filter((s) => inCohort.some((f) => f.severity === s));
    return {
      label: cohort,
      kind: "cohort",
      children: severities.map((sev) => ({
        label: sev,
        kind: "severity",
        children: inCohort
          .filter((f) => f.severity === sev)
          .map((f) => ({ label: `${f.state === "open" ? "" : `[${f.state}] `}${f.title}`, kind: "finding" as const, children: [], finding: f })),
      })),
    };
  });
}

/** The actions the tree offers on a finding, by its current state. */
// @spec EXT-VIEW-007
export function findingActions(state: OfferedFinding["state"]): ("dismissed" | "fixed" | "open")[] {
  return state === "open" ? ["dismissed", "fixed"] : ["open"];
}
