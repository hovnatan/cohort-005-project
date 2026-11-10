import { data, redirect } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/courses.$slug.refund-request";
import { getCurrentUserId } from "~/lib/session";
import { db } from "~/db";
import { courses, users } from "~/db/schema";
import { eq } from "drizzle-orm";
import { parseFormData, parseParams } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import {
  createRefundRequest,
  getRefundRequestEligibility,
  REFUND_WINDOW_DAYS,
  type IneligibleReason,
} from "~/lib/refund-requests.server";

// A learner makes a Refund Request from the course page. The rules for who may
// make one live in ~/lib/refund-requests.server, shared with the page that
// decides whether to show the button; this route only turns a refusal into a
// response and records the request.

const refundRequestParamsSchema = z.object({
  slug: z.string().min(1),
});

const refundRequestActionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(10, "Tell us a little more about why you want a refund.")
    .max(1000, "Please keep your reason under 1000 characters."),
});

// What the learner is told for each refusal, and the status it is sent with.
const REFUSALS: Record<IneligibleReason, { message: string; status: number }> =
  {
    no_purchase: { message: "You have not bought this course.", status: 403 },
    open_request: {
      message: "You already have a refund request open on this purchase.",
      status: 409,
    },
    claimed_team_seat: {
      message: "A claimed team seat cannot be refunded.",
      status: 403,
    },
    window_closed: {
      message: `The ${REFUND_WINDOW_DAYS}-day refund window has closed.`,
      status: 403,
    },
    too_much_completed: {
      message: "You have completed too much of this course to get a refund.",
      status: 403,
    },
    too_much_watched: {
      message: "You have watched too much of this course to get a refund.",
      status: 403,
    },
  };

function getCourseBySlug(slug: string) {
  return db.select().from(courses).where(eq(courses.slug, slug)).get();
}

/**
 * The confirmation the learner gets in their inbox. There is no mail
 * transport wired up yet, so the built message goes to the server log.
 */
function buildRefundRequestEmail(input: {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  amount: number;
}) {
  return {
    to: input.learnerEmail,
    subject: `Refund requested - ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have your refund request for "${input.courseTitle}".`,
      `If it is approved, your refund will be ${formatPrice(input.amount)}, the amount you paid, and you will no longer have access to the course.`,
      "",
      "Our team reviews every refund request by hand. You do not need to do anything else - we will email you again when it is done.",
      "",
      "- The Cadence team",
    ].join("\n"),
  };
}

export async function action({ params, request }: Route.ActionArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("You must be logged in to request a refund.", { status: 401 });
  }

  const { slug } = parseParams(params, refundRequestParamsSchema);
  const course = getCourseBySlug(slug);

  if (!course) {
    throw data("Course not found", { status: 404 });
  }

  const learner = db
    .select()
    .from(users)
    .where(eq(users.id, currentUserId))
    .get();

  if (!learner) {
    throw data("User not found", { status: 404 });
  }

  const eligibility = getRefundRequestEligibility(currentUserId, course.id);

  if (!eligibility.eligible) {
    const refusal = REFUSALS[eligibility.reason];
    throw data(refusal.message, { status: refusal.status });
  }

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundRequestActionSchema);

  if (!parsed.success) {
    return data({ errors: parsed.errors }, { status: 400 });
  }

  createRefundRequest(eligibility.purchaseId, parsed.data.reason);

  const email = buildRefundRequestEmail({
    learnerName: learner.name,
    learnerEmail: learner.email,
    courseTitle: course.title,
    amount: eligibility.amount,
  });

  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return redirect("/settings");
}
