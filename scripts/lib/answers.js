// Answer policy: maps ATS question labels to answers, driven entirely by the
// applicant profile. This replaces three divergent hardcoded copies of the same
// logic (one per ATS) from the original codebase.
//
// Safety rules learned from real misfills — DO NOT weaken these:
//   * Demographic / diversity-survey questions are NEVER auto-answered (a
//     generic first-option fallback once answered "Yes" to a transgender-
//     identity question). Declining to state pronouns is the one exception —
//     declining is not a demographic claim.
//   * When no option matches the intended answer, SKIP and surface a warning
//     rather than guess: a 2-option id-sort fallback once asserted "authorized
//     to work for ANY employer" for a visa-holding applicant.
//   * Never make positive claims that invite follow-ups and are almost
//     certainly false for a mass-apply tool: "have you interviewed here
//     before", "were you referred", "do you know anyone here", "are you a
//     <product> user" all default to No.
//   * Consent opt-ins (SMS/marketing) never default to Yes.

'use strict';

// Questions that must never be auto-answered (demographics / diversity surveys).
const DEMOGRAPHIC_RE = /\bgender\b|gender identity|transgender|sexual orientation|\brace\b|ethnic|hispanic|latino|\bveteran\b|disabilit|disabled status|age range|(your|current) age\b|what is your age|diversity survey|do you identify as/i;

// "How did you hear about us" phrasings — shared across ATSes.
const SOURCE_Q_RE = /how did you hear|hear about (this|us|the)|referral source|source of application|where did you (hear|find)/i;

// EEO "decline to answer" option matcher.
const DECLINE_RE = /decline|prefer not|not to disclose|don'?t wish|do not (wish|want)|not to answer|not listed/i;

/**
 * Build a policy for one profile. Returns:
 *   pickYesNo(questionLabel) -> 'yes' | 'no' | null   (null = skip + warn)
 *   textAnswer(label)        -> string | null          (common text fields)
 *   isDemographic(label)     -> boolean
 *   isSourceQuestion(label)  -> boolean
 */
function buildPolicy(profile) {
  function pickYesNo(qLab) {
    const q = (qLab || '').toLowerCase();
    let want = 'yes';

    // Employment status. Any "currently employed/working" phrasing answers from
    // the profile — the generic default-yes once claimed employment for an
    // applicant whose role had ended.
    if (/currently employed|currently working\b/.test(q)) want = profile.currentlyEmployed ? 'yes' : 'no';
    if (/previously been employed|former employee|previous employee|ever (worked|been employed)/.test(q)) want = 'no';

    // Prior-contact questions: false positives invite "who?"/"when?" follow-ups.
    if (/interviewed (with|at|for|here)|previously interviewed|ever interviewed|interview(ed)? .*before/.test(q)) want = 'no';
    if (/referred (by|from)/.test(q) && !/were you/.test(q)) want = 'no';
    if (/do you know (anyone|someone|any ?one)|know anyone (who works|at|currently)|any (friends|contacts|connections) (who work|at)/.test(q)) want = 'no';

    if (/sanctioned|cuba|iran|north korea|syria|russia|belarus|crimea/.test(q)) want = 'no';

    // Work authorization — the sanity questions from onboarding drive these.
    if (/authorized to work|legally authorized|eligible to work/.test(q)) {
      want = profile.workAuthorized ? 'yes' : 'no';
    }
    // "UNRESTRICTED authorization" / "without sponsorship" is the inverted phrasing.
    if (/unrestricted work authorization|without (visa |any )?sponsorship|not require sponsorship|do not require sponsorship|work.*without.*sponsorship/.test(q)) {
      want = profile.needsSponsorship ? 'no' : 'yes';
    }
    if (/require.*sponsorship|need.*sponsorship|require.*visa|need.*visa|now or in the future.*sponsor|sponsorship (now or in the future|to work|in the future)/.test(q)) {
      want = profile.needsSponsorship ? 'yes' : 'no';
    }

    if (/willing to (commute|relocate)|relocate to|live near|bay area|based in|hybrid|in-?office|on-?site|come (in|into) (the )?office|days (a|per) week|comfortable working/.test(q)) {
      want = profile.willingToRelocate ? 'yes' : 'no';
    }
    if (/are you (over )?18|over the age|18 years|age of majority/.test(q)) want = profile.over18 ? 'yes' : 'no';
    if (/conflict of interest|non[- ]?compete|nda preventing/.test(q)) want = profile.noNoncompete ? 'no' : 'yes';
    if (/prior conviction|felony|criminal/.test(q)) {
      // Tri-state: only auto-answer when the profile explicitly says the record
      // is clean. Anything else is skipped for human review.
      if (profile.cleanRecord === true) want = 'no';
      else return null;
    }

    // "Are you a <product> user?" — false claims get probed in interviews.
    if (/are you (a|an) [\w .'’-]*\b(user|customer)\b|are you a (user|customer) of|do you (currently )?use (our|the) (product|app|tool|service)|have you (ever )?used (our|the|this) (product|app|tool|service)/.test(q)) want = 'no';

    // Student / new-grad status. Placed last so it overrides the default;
    // "college degree"/"authorized to work" phrasings don't match and keep
    // their correct answers.
    if (/currently enrolled|are you (currently )?a (full[- ]?time )?student|student or new grad|\bnew grad(uate)?\b|enrolled in (a )?(full[- ]?time )?(education|school|university|degree|classes|program)/.test(q)) {
      want = profile.isStudent ? 'yes' : 'no';
    }
    return want;
  }

  function textAnswer(rawLabel, { isDatePicker = false } = {}) {
    const lab = (rawLabel || '').toLowerCase();
    if (SOURCE_Q_RE.test(rawLabel || '')) return profile.howHeard;
    if (/linkedin/.test(lab)) return profile.linkedin || null;
    if (/github/.test(lab)) return profile.github || null;
    if (/website|portfolio|personal site/.test(lab)) return profile.website || null;
    if (/full name/.test(lab)) return profile.name;
    if (/first name/.test(lab)) return profile.firstName;
    if (/last name|surname|family name/.test(lab)) return profile.lastName;
    if (/preferred\s+(first\s+)?name/.test(lab)) return profile.preferredName;
    if (/current location|place of residence|where.*located|city.*(state|located)|where (are you|do you (live|reside))|location/.test(lab)) return profile.locationFull;
    if (/^city\b|^town\b|town\/city/.test(lab)) return profile.city;
    if (/^state\b|state\/province|province/.test(lab)) return profile.state;
    if (/zip|postal/.test(lab)) return profile.zip || null;
    if (/address line 1|street address|^address\b/.test(lab)) return profile.addressLine1 || null;
    if (/current company|company name|employer|most recent company/.test(lab)) return profile.currentEmployer || null;
    if (/job title|recent job title|current title|role title|current role\b/.test(lab)) return profile.currentTitle || null;
    if (/phone/.test(lab)) return profile.phone || null;
    if (/years of (relevant )?(software|engineering|professional) experience|years of experience|yoe|how many years/.test(lab)) return profile.yoe || null;
    if (/start date|available start|when can you start|when (could|can) you (start|join)|available to (start|join)|earliest (month|date|time)|notice period/.test(lab)) {
      return isDatePicker ? startDateFourWeeksOut() : profile.startAvailability;
    }
    if (/desired (compensation|salary)|salary expectation|compensation expectation|expected (salary|compensation|pay)|salary|base compensation/.test(lab)) {
      return profile.desiredComp || 'Open to discussion based on the full role and total compensation.';
    }
    if (/sponsorship.*explain|if yes.*explain|explain.*sponsorship|visa status|current visa/.test(lab)) return profile.sponsorshipExplain;
    if (/accelerated timeline|competing offer|decision by|timeline for making|deadline for|need a decision/.test(lab)) return 'No, I am on a standard timeline.';
    return null;
  }

  return {
    profile,
    pickYesNo,
    textAnswer,
    isDemographic: (label) => DEMOGRAPHIC_RE.test(label || ''),
    isSourceQuestion: (label) => SOURCE_Q_RE.test(label || ''),
  };
}

// Date-picker widgets reject prose ("Immediately"); they accept a typed
// MM/DD/YYYY, so answer start-date questions with a date ~4 weeks out.
function startDateFourWeeksOut() {
  const d = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

module.exports = { buildPolicy, DEMOGRAPHIC_RE, SOURCE_Q_RE, DECLINE_RE, startDateFourWeeksOut };
