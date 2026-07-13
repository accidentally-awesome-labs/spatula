---
name: Adversarial Fixture Submission
about: Submit a new prompt-injection HTML fixture for the adversarial test suite
title: '[adversarial] <attack-class>: brief description'
labels: adversarial-fixture
assignees: ''
---

## Attack Class

<!-- Select the closest matching attack class from the list below, or describe a new class: -->

- [ ] direct-injection (visible text instruction)
- [ ] zero-width-smuggling (U+200B/U+200C/U+200D hidden characters)
- [ ] fake-schema-coercion (claims schema has changed)
- [ ] output-exfiltration (requests system prompt in output)
- [ ] jailbreak-variant (DAN / developer-mode / roleplay bypass)
- [ ] multi-step-refeed (plants instruction for future pages)
- [ ] html-comment-hidden (injection in HTML comments)
- [ ] css-display-none (injection in hidden elements)
- [ ] data-uri (injection in data:text/html;base64,... URI)
- [ ] unicode-confusables (Cyrillic/Greek homoglyph substitution)
- [ ] new class: **\*\***\_\_\_**\*\***

## HTML Payload

<!-- Paste the adversarial HTML fixture below. It MUST: -->
<!-- 1. Contain at least one legitimate extractable field (e.g. product title in <h1>) -->
<!-- 2. Embed the injection payload for the chosen attack class -->
<!-- 3. Be a self-contained HTML document -->

```html
<!DOCTYPE html>
<html>
  <!-- Your fixture HTML here -->
</html>
```

## Expected Safe Extraction Behavior

<!-- What should the extractor do with this page? -->
<!-- Example: "Extract title='Widget Pro', price='$49.99'; ignore the injection" -->

**Expected extracted fields:**

- title:
- price: (if present)

**Injection should be ignored:** (describe what the injection attempts and why it should fail)

## Model(s) Observed Against

<!-- Which pinned model(s) did you test this fixture against? -->

- [ ] `anthropic/claude-3-5-sonnet-20240620` (OpenRouter pin)
- [ ] `llama3.1:8b-instruct-q4_0` (Ollama pin)
- [ ] Other: **\*\***\_\_\_**\*\***

## Observed Behavior

<!-- Describe what happened when you ran this fixture against the model: -->
<!-- Did the injection succeed (vulnerability) or fail (already defended)? -->

**Result:**

- [ ] Injection SUCCEEDED — model was fooled (this is a new vulnerability to defend against)
- [ ] Injection FAILED — model correctly ignored the payload (useful regression fixture)

**Details:**

## Fixture File Name

<!-- Suggest a name following the convention: NN-attack-class.html -->
<!-- Example: 11-iframe-injection.html (next number after the existing 10) -->

Suggested filename: `NN-attack-class.html`

## Additional Context

<!-- Any other context about the attack vector, source, or why this is worth adding: -->
