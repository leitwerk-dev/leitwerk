import { describe, it } from "vitest";
import * as scenarios from "./jira-gitlab-scenarios.js";

describe("Jira coordinated GitLab change", () => {
	it(
		"repairs repositories independently and aborts when every MR closes unmerged",
		scenarios.independentRepositoryRepair,
		45000,
	);
});

it(
	"settles feedback independently and escalates only the repository that exhausts three CI repairs",
	scenarios.feedbackCiBudget,
	90000,
);

it(
	"does not replay a no-change CI repair for MR metadata updates, including after restart",
	scenarios.noChangeCiRepair,
	// Three repairs now each execute a delivery verification worker as well.
	90000,
);

it(
	"runs Deliver once through preparing, running and green CI, then invokes Address Feedback directly",
	scenarios.directFeedback,
	// Includes changed and no-change delivery verification, acknowledgement, and restart.
	120000,
);
