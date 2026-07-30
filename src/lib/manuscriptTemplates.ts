export type ManuscriptFormat = "empty" | "paper" | "screenplay" | "dissertation";

export interface ManuscriptTemplate {
  id: ManuscriptFormat;
  label: string;
  description: string;
  ruleFile?: string;
  seed: (title: string) => string;
}

export const MANUSCRIPT_TEMPLATES: ManuscriptTemplate[] = [
  {
    id: "empty",
    label: "Empty",
    description: "Blank document. Start from scratch.",
    seed: () => "",
  },
  {
    id: "paper",
    label: "Paper",
    description: "Academic article (Abstract, IMRaD, References). A4 serif.",
    ruleFile: "paper-rule.md",
    seed: (t) => `# ${t}

## Abstract

## Keywords

## 1. Introduction

## 2. Related Work

## 3. Methods

## 4. Results

## 5. Discussion

## 6. Conclusion

## References
`,
  },
  {
    id: "screenplay",
    label: "Screenplay",
    description: "Fountain-style script. Use Export → Screenplay for layout.",
    ruleFile: "screenplay-rule.md",
    seed: (t) => `Title: ${t}
Author:
Draft date:

## INT. LOCATION - DAY

Action goes here.

**CHARACTER** — dialogue.
`,
  },
  {
    id: "dissertation",
    label: "Dissertation",
    description: "Thesis (front matter, chapters, references, appendices). A4 12pt.",
    ruleFile: "dissertation-rule.md",
    seed: (t) => `Title: ${t}
Author:
Credit: A thesis submitted for the degree of
Date:

## Abstract

## Acknowledgements

## Chapter 1. Introduction
### 1.1 Background
### 1.2 Objectives
### 1.3 Scope

## Chapter 2. Literature Review

## Chapter 3. Methodology

## Chapter 4. Results

## Chapter 5. Discussion

## Chapter 6. Conclusion

## References

## Appendix A.
`,
  },
];

export function templateFor(id: ManuscriptFormat): ManuscriptTemplate {
  return MANUSCRIPT_TEMPLATES.find((m) => m.id === id) ?? MANUSCRIPT_TEMPLATES[0];
}
