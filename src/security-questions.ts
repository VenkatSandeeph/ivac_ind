import type { Page, Locator } from 'patchright';
import { SecurityQuestionConfig } from './config';
import { info, warn } from './logger';

function cleanText(text: string) {
  return text
    // The site mixes typographic quotes into question text (observed: U+2019
    // in "didn’t") while stored configs use ASCII — normalize both sides so
    // matching is punctuation-style agnostic.
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function matchQuestionText(question: string, configured: string) {
  const normalizedQuestion = cleanText(question);
  const normalizedConfigured = cleanText(configured);
  return (
    normalizedQuestion.includes(normalizedConfigured) ||
    normalizedConfigured.includes(normalizedQuestion) ||
    normalizedQuestion === normalizedConfigured
  );
}

async function extractText(locator: Locator): Promise<string> {
  const ariaLabel = await locator.getAttribute('aria-label');
  if (ariaLabel?.trim()) {
    return ariaLabel.trim();
  }
  return (await locator.innerText().catch(() => '')).trim();
}

async function findAnswerFieldForQuestion(questionElement: Locator): Promise<Locator | null> {
  const field = questionElement.locator('xpath=ancestor::li[1]/following-sibling::li[1]//input[@type="password"]');
  if ((await field.count()) > 0) {
    return field.first();
  }

  const nearbyField = questionElement.locator('xpath=ancestor::li[1]//following::input[@type="password"][1]');
  if ((await nearbyField.count()) > 0) {
    return nearbyField.first();
  }

  return null;
}

async function findAnswerFieldFromLabel(label: Locator): Promise<Locator | null> {
  const forAttr = await label.getAttribute('for');
  if (forAttr) {
    const field = label.page().locator(`#${forAttr}`);
    if ((await field.count()) > 0) {
      return field.first();
    }
  }

  const siblingField = label.locator('xpath=following::input[1] | following::textarea[1]');
  if ((await siblingField.count()) > 0) {
    return siblingField.first();
  }

  const parentField = label.locator('xpath=ancestor::label//input | ancestor::label//textarea');
  if ((await parentField.count()) > 0) {
    return parentField.first();
  }

  return null;
}

export async function answerSecurityQuestions(page: Page, configuredQuestions: SecurityQuestionConfig[]) {
  info('Checking for security questions');

  const questionParagraphs = page.locator('p.textInParagraph[id^="kbq"], p.textInParagraph[aria-label]');
  const totalQuestions = await questionParagraphs.count();
  const questionPairs: Array<{ field: Locator; answer: string; labelText: string }> = [];

  for (let index = 0; index < totalQuestions; index++) {
    const questionElement = questionParagraphs.nth(index);
    const questionText = await extractText(questionElement);
    if (!questionText) continue;

    const matching = configuredQuestions.find((questionConfig) =>
      matchQuestionText(questionText, questionConfig.question)
    );

    if (!matching) {
      warn('Unrecognized security question detected:', questionText);
      throw new Error(`Unknown security question: ${questionText}`);
    }

    const field = await findAnswerFieldForQuestion(questionElement);
    if (!field) {
      throw new Error(`Unable to locate answer field for question: ${questionText}`);
    }

    questionPairs.push({ field, answer: matching.answer, labelText: questionText });
  }

  if (questionPairs.length === 0) {
    const labels = page.locator('label');
    const totalLabels = await labels.count();
    if (totalLabels === 0) {
      info('No security questions detected');
      return;
    }

    for (let index = 0; index < totalLabels; index++) {
      const label = labels.nth(index);
      const labelText = await extractText(label);
      if (!labelText) continue;

      const matching = configuredQuestions.find((questionConfig) =>
        matchQuestionText(labelText, questionConfig.question)
      );

      if (!matching) {
        warn('Unrecognized security question detected:', labelText);
        throw new Error(`Unknown security question: ${labelText}`);
      }

      const field = await findAnswerFieldFromLabel(label);
      if (!field) {
        throw new Error(`Unable to locate answer field for question: ${labelText}`);
      }

      questionPairs.push({ field, answer: matching.answer, labelText });
    }
  }

  if (questionPairs.length === 0) {
    info('No matched security question fields were found');
    return;
  }

  for (const pair of questionPairs) {
    info('Answering security question:', pair.labelText);
    await pair.field.fill(pair.answer);
  }

  const continueButton = page.locator('button#continue');
  if ((await continueButton.count()) === 0) {
    const fallbackButton = page.getByRole('button', { name: /continue|next|submit/i });
    await fallbackButton.waitFor({ state: 'visible', timeout: 30000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      fallbackButton.click()
    ]);
  } else {
    await continueButton.waitFor({ state: 'visible', timeout: 30000 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      continueButton.click()
    ]);
  }

  info('Submitted security question answers');
}
