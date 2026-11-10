import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { createTestDb, seedBaseData } from "~/test/setup";
import {
  createRefundRequest,
  decideRefundRequestEligibility,
  getRefundRequestEligibility,
  MAX_WATCHED_SECONDS,
  type EligibilityFacts,
} from "./refund-requests.server";

// The module reads `db` from ~/db; point it at a fresh in-memory database per
// test. The getter defers the lookup until the module actually queries.
let testDb: ReturnType<typeof createTestDb>;
vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Local-time dates, because the Refund Window is counted in local calendar days.
function at(year: number, month: number, day: number, hour = 12) {
  return new Date(year, month - 1, day, hour);
}

function facts(overrides: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    purchase: {
      id: 1,
      amountPaid: 3999,
      createdAt: at(2026, 3, 1).toISOString(),
    },
    hasOpenRequest: false,
    hasClaimedTeamSeat: false,
    lessonCount: 10,
    completedLessonCount: 0,
    watchedSeconds: 0,
    ...overrides,
  };
}

describe("decideRefundRequestEligibility", () => {
  it("offers the amount paid and the last day of the window", () => {
    expect(decideRefundRequestEligibility(facts(), at(2026, 3, 2))).toEqual({
      eligible: true,
      purchaseId: 1,
      amount: 3999,
      lastDayInWindow: "2026-03-15",
    });
  });

  describe("Refund Window", () => {
    // Bought at 23:00 on the 1st: the whole of the 15th is still inside.
    const lateBuy = facts({
      purchase: {
        id: 1,
        amountPaid: 3999,
        createdAt: at(2026, 3, 1, 23).toISOString(),
      },
    });

    it("is open until the end of the 14th day after purchase", () => {
      expect(
        decideRefundRequestEligibility(lateBuy, at(2026, 3, 15, 23)).eligible
      ).toBe(true);
    });

    it("is closed on the 15th day after purchase", () => {
      expect(
        decideRefundRequestEligibility(lateBuy, at(2026, 3, 16, 0))
      ).toEqual({
        eligible: false,
        reason: "window_closed",
      });
    });
  });

  describe("Completed share", () => {
    it("refuses at 50% of lessons completed", () => {
      const result = decideRefundRequestEligibility(
        facts({ lessonCount: 6, completedLessonCount: 3 }),
        at(2026, 3, 2)
      );
      expect(result).toEqual({ eligible: false, reason: "too_much_completed" });
    });

    it("allows just under 50%", () => {
      const result = decideRefundRequestEligibility(
        facts({ lessonCount: 10, completedLessonCount: 4 }),
        at(2026, 3, 2)
      );
      expect(result.eligible).toBe(true);
    });

    it("does not divide by zero for a course with no lessons", () => {
      const result = decideRefundRequestEligibility(
        facts({ lessonCount: 0, completedLessonCount: 0 }),
        at(2026, 3, 2)
      );
      expect(result.eligible).toBe(true);
    });
  });

  describe("Watched Time", () => {
    it("refuses at two hours", () => {
      const result = decideRefundRequestEligibility(
        facts({ watchedSeconds: MAX_WATCHED_SECONDS }),
        at(2026, 3, 2)
      );
      expect(result).toEqual({ eligible: false, reason: "too_much_watched" });
    });

    it("allows one second under two hours", () => {
      const result = decideRefundRequestEligibility(
        facts({ watchedSeconds: MAX_WATCHED_SECONDS - 1 }),
        at(2026, 3, 2)
      );
      expect(result.eligible).toBe(true);
    });
  });

  it.each([
    ["no_purchase", { purchase: undefined }],
    ["open_request", { hasOpenRequest: true }],
    ["claimed_team_seat", { hasClaimedTeamSeat: true }],
  ] as const)("refuses with %s", (reason, overrides) => {
    expect(
      decideRefundRequestEligibility(facts(overrides), at(2026, 3, 2))
    ).toEqual({
      eligible: false,
      reason,
    });
  });

  it("reports an open request ahead of a closed window", () => {
    const result = decideRefundRequestEligibility(
      facts({ hasOpenRequest: true }),
      at(2026, 6, 1)
    );
    expect(result).toEqual({ eligible: false, reason: "open_request" });
  });
});

describe("getRefundRequestEligibility (against the database)", () => {
  let base: ReturnType<typeof seedBaseData>;
  let lessonIds: number[];
  const today = at(2026, 3, 2);
  const boughtAt = at(2026, 3, 1).toISOString();

  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);

    // Six lessons, so three completed is exactly 50%.
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "Module 1", position: 1 })
      .returning()
      .get();
    lessonIds = [1, 2, 3, 4, 5, 6].map(
      (position) =>
        testDb
          .insert(schema.lessons)
          .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
          .returning()
          .get().id
    );
  });

  function buy(amountPaid: number) {
    return testDb
      .insert(schema.purchases)
      .values({
        userId: base.user.id,
        courseId: base.course.id,
        amountPaid,
        country: "US",
        createdAt: boughtAt,
      })
      .returning()
      .get();
  }

  function complete(count: number) {
    for (const lessonId of lessonIds.slice(0, count)) {
      testDb
        .insert(schema.lessonProgress)
        .values({
          userId: base.user.id,
          lessonId,
          status: schema.LessonProgressStatus.Completed,
          completedAt: boughtAt,
        })
        .run();
    }
  }

  // Regression: the offer used to be the course's current list price whenever
  // the purchase had no PPP discount, so a price rise refunded more than paid.
  it("offers what was paid, not the current list price", () => {
    buy(3999);
    testDb
      .update(schema.courses)
      .set({ price: 5999 })
      .where(eq(schema.courses.id, base.course.id))
      .run();

    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toMatchObject({ eligible: true, amount: 3999 });
  });

  // An unclaimed team licence is given back whole: all seats, not one.
  it("offers the full amount of an unclaimed team licence", () => {
    buy(5999 * 5);
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toMatchObject({ eligible: true, amount: 5999 * 5 });
  });

  // Regression: the course page hid the button at 50% completed, but the
  // action never checked, so a direct POST was accepted.
  it("refuses a learner who has completed half the lessons", () => {
    buy(3999);
    complete(3);
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toEqual({ eligible: false, reason: "too_much_completed" });
  });

  it("counts a lesson with duplicate progress rows once", () => {
    buy(3999);
    complete(2);
    complete(1); // lesson 1 again
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result.eligible).toBe(true);
  });

  it("sums the furthest point per lesson for Watched Time", () => {
    buy(3999);
    // Lesson 1 watched twice to 3000s (counts once), lesson 2 to 4200s:
    // 3000 + 4200 = 7200s = exactly two hours.
    for (const [lessonId, position] of [
      [lessonIds[0], 3000],
      [lessonIds[0], 3000],
      [lessonIds[1], 4200],
    ] as const) {
      testDb
        .insert(schema.videoWatchEvents)
        .values({
          userId: base.user.id,
          lessonId,
          eventType: "progress",
          positionSeconds: position,
        })
        .run();
    }
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toEqual({ eligible: false, reason: "too_much_watched" });
  });

  it("refuses a second request while one is open", () => {
    const purchase = buy(3999);
    createRefundRequest(purchase.id, "Not what I expected at all.");
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toEqual({ eligible: false, reason: "open_request" });
  });

  it("refuses a purchase with a claimed team seat", () => {
    const purchase = buy(5999 * 5);
    const team = testDb.insert(schema.teams).values({}).returning().get();
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        purchaseId: purchase.id,
        code: "seat-1",
        redeemedAt: boughtAt,
      })
      .run();
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toEqual({ eligible: false, reason: "claimed_team_seat" });
  });

  it("refuses a learner who never bought the course", () => {
    const result = getRefundRequestEligibility(
      base.user.id,
      base.course.id,
      today
    );
    expect(result).toEqual({ eligible: false, reason: "no_purchase" });
  });
});
