import { describe, expect, it } from "vitest";
import { DEPARTMENT_CODES, departmentLabel, departmentLabels } from "@/lib/constants";

/**
 * Department label mapping — presentation-only. Stored values remain the
 * plain codes (PWD/SWM/…); the mapping must cover EVERY valid code so no
 * UI surface ever falls back to a raw code by accident.
 */
describe("departmentLabels (single source of truth)", () => {
  it("covers every DEPARTMENT_CODES entry with a non-empty label", () => {
    for (const code of DEPARTMENT_CODES) {
      const label = departmentLabels[code];
      expect(label, `missing label for ${code}`).toBeTruthy();
      expect(label.length).toBeGreaterThanOrEqual(2);
    }
    expect(Object.keys(departmentLabels).sort()).toEqual([...DEPARTMENT_CODES].sort());
  });

  it("maps each code to the canonical department name", () => {
    expect(departmentLabel("PWD")).toBe("Public Works Department");
    expect(departmentLabel("SWM")).toBe("Solid Waste Management");
    expect(departmentLabel("ELECT")).toBe("Electricity Department");
    expect(departmentLabel("WATER")).toBe("Water & Sewerage Department");
    expect(departmentLabel("HEALTH")).toBe("Public Health Department");
    expect(departmentLabel("GEN")).toBe("General Municipal Department");
  });

  it("falls back to the raw code for unknown values (never throws)", () => {
    expect(departmentLabel("X-X")).toBe("X-X");
    expect(departmentLabel("")).toBe("");
  });
});
