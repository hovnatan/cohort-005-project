import {
  and,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  sql,
} from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  lessonProgress,
  lessons,
  LessonProgressStatus,
  modules,
  purchases,
  refundRequests,
  RefundRequestStatus,
  videoWatchEvents,
} from "~/db/schema";

// ─── Refund Requests ───
// The one place that decides whether a learner may make a Refund Request on a
// course, and for how much. See GLOSSARY.md for the terms.
//
//   course page loader ──┐                ┌── shows "Request a refund" or not
//                        ├─> getRefundRequestEligibility(userId, courseId, today)
//   refund-request action┘        │       └── accepts the request or throws
//                                 v
//                    loadEligibilityFacts   (all DB reads, here only)
//                                 │
//                                 v
//                 decideRefundRequestEligibility (pure rules, no DB)
//
// Both callers go through the same function so the button the learner sees and
// the request the server accepts can never disagree again.

export const REFUND_WINDOW_DAYS = 14;
export const MAX_WATCHED_SECONDS = 2 * 60 * 60;
// A learner who has completed this share of the course's lessons has had the
// course, whether or not the videos say so.
export const MAX_COMPLETED_SHARE = 0.5;

export type RefundRequestOffer = {
  eligible: true;
  purchaseId: number;
  // Always what the learner actually paid for the Purchase - never the
  // course's current list price, which may have changed since.
  amount: number;
  lastDayInWindow: string;
};

export type IneligibleReason =
  | "no_purchase"
  | "open_request"
  | "claimed_team_seat"
  | "window_closed"
  | "too_much_completed"
  | "too_much_watched";

export type RefundRequestEligibility =
  RefundRequestOffer | { eligible: false; reason: IneligibleReason };

export type EligibilityFacts = {
  purchase: { id: number; amountPaid: number; createdAt: string } | undefined;
  hasOpenRequest: boolean;
  hasClaimedTeamSeat: boolean;
  lessonCount: number;
  completedLessonCount: number;
  watchedSeconds: number;
};

// ─── Pure rules ───

// The Refund Window is counted in whole calendar days, not hours: someone who
// buys at 23:00 on the 1st still gets all of the 15th.
export function calendarDay(when: Date): string {
  const year = when.getFullYear();
  const month = String(when.getMonth() + 1).padStart(2, "0");
  const day = String(when.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function lastDayOfRefundWindow(purchasedAtIso: string): string {
  const deadline = new Date(purchasedAtIso);
  deadline.setDate(deadline.getDate() + REFUND_WINDOW_DAYS);
  return calendarDay(deadline);
}

/**
 * Applies the rules in a fixed order, so a learner who fails several gets the
 * first reason: e.g. a request already open wins over a closed window.
 */
export function decideRefundRequestEligibility(
  facts: EligibilityFacts,
  today: Date
): RefundRequestEligibility {
  const { purchase } = facts;

  if (!purchase) return { eligible: false, reason: "no_purchase" };
  if (facts.hasOpenRequest) return { eligible: false, reason: "open_request" };

  // A claimed seat from a team licence belongs to the team; the buyer cannot
  // hand it back on their own.
  if (facts.hasClaimedTeamSeat) {
    return { eligible: false, reason: "claimed_team_seat" };
  }

  const todayDay = calendarDay(today);
  const lastDayInWindow = lastDayOfRefundWindow(purchase.createdAt);
  if (todayDay > lastDayInWindow) {
    return { eligible: false, reason: "window_closed" };
  }

  if (
    facts.lessonCount > 0 &&
    facts.completedLessonCount / facts.lessonCount >= MAX_COMPLETED_SHARE
  ) {
    return { eligible: false, reason: "too_much_completed" };
  }

  if (facts.watchedSeconds >= MAX_WATCHED_SECONDS) {
    return { eligible: false, reason: "too_much_watched" };
  }

  return {
    eligible: true,
    purchaseId: purchase.id,
    amount: purchase.amountPaid,
    lastDayInWindow,
  };
}

// ─── DB reads ───

function getLatestPurchase(userId: number, courseId: number) {
  return db
    .select({
      id: purchases.id,
      amountPaid: purchases.amountPaid,
      createdAt: purchases.createdAt,
    })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.courseId, courseId)))
    .orderBy(desc(purchases.createdAt))
    .get();
}

function getLessonIdsForCourse(courseId: number): number[] {
  return db
    .select({ id: lessons.id })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(modules.courseId, courseId))
    .all()
    .map((row) => row.id);
}

export function getOpenRefundRequest(purchaseId: number) {
  return db
    .select()
    .from(refundRequests)
    .where(
      and(
        eq(refundRequests.purchaseId, purchaseId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .get();
}

function hasClaimedTeamSeat(purchaseId: number) {
  const seat = db
    .select({ id: coupons.id })
    .from(coupons)
    .where(
      and(eq(coupons.purchaseId, purchaseId), isNotNull(coupons.redeemedAt))
    )
    .get();
  return seat !== undefined;
}

// Distinct lessons, so a duplicate progress row cannot count a lesson twice.
function getCompletedLessonCount(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const row = db
    .select({ count: countDistinct(lessonProgress.lessonId) })
    .from(lessonProgress)
    .where(
      and(
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed),
        inArray(lessonProgress.lessonId, lessonIds)
      )
    )
    .get();

  if (!row) throw new Error("count() query returned no row");
  return row.count;
}

// Watched Time: the furthest point reached in each lesson, summed. Rewatching
// a lesson adds nothing; skipping ahead counts.
function getWatchedSeconds(userId: number, lessonIds: number[]) {
  if (lessonIds.length === 0) return 0;

  const furthestPerLesson = db
    .select({
      furthest: sql<number>`max(${videoWatchEvents.positionSeconds})`,
    })
    .from(videoWatchEvents)
    .where(
      and(
        eq(videoWatchEvents.userId, userId),
        inArray(videoWatchEvents.lessonId, lessonIds)
      )
    )
    .groupBy(videoWatchEvents.lessonId)
    .all();

  return furthestPerLesson.reduce((total, row) => total + row.furthest, 0);
}

function loadEligibilityFacts(
  userId: number,
  courseId: number
): EligibilityFacts {
  const purchase = getLatestPurchase(userId, courseId);
  const lessonIds = getLessonIdsForCourse(courseId);

  return {
    purchase,
    hasOpenRequest: purchase
      ? getOpenRefundRequest(purchase.id) !== undefined
      : false,
    hasClaimedTeamSeat: purchase ? hasClaimedTeamSeat(purchase.id) : false,
    lessonCount: lessonIds.length,
    completedLessonCount: getCompletedLessonCount(userId, lessonIds),
    watchedSeconds: getWatchedSeconds(userId, lessonIds),
  };
}

// ─── Public API ───

export function getRefundRequestEligibility(
  userId: number,
  courseId: number,
  today: Date = new Date()
): RefundRequestEligibility {
  return decideRefundRequestEligibility(
    loadEligibilityFacts(userId, courseId),
    today
  );
}

/** A learner's Refund Requests still waiting on staff, for the settings page. */
export function getOpenRefundRequestsForLearner(userId: number) {
  return db
    .select({
      id: refundRequests.id,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      reason: refundRequests.reason,
      requestedAt: refundRequests.requestedAt,
    })
    .from(refundRequests)
    .innerJoin(purchases, eq(refundRequests.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(
      and(
        eq(purchases.userId, userId),
        eq(refundRequests.status, RefundRequestStatus.Requested)
      )
    )
    .all();
}

export function createRefundRequest(purchaseId: number, reason: string) {
  return db
    .insert(refundRequests)
    .values({
      purchaseId,
      status: RefundRequestStatus.Requested,
      reason,
    })
    .returning()
    .get();
}
