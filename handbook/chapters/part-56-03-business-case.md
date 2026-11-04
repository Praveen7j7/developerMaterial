## 56.3 Building a business case

#### Concept

A business case is the quantified argument that an investment is worth making, in the terms a business uses to decide: return on investment (ROI), cost of delay, the value of reducing risk, and opportunity cost. For engineering work — especially non-feature work like reliability, platform, and tech debt — building a business case is how you compete for funding against features that arrive with revenue numbers attached. The skill is turning engineering value, which feels qualitative ("it'll be more reliable"), into quantitative, defensible numbers a finance partner can accept. Without a business case, engineering investments lose every funding argument to features, because features have numbers and "it'll be better" does not.

#### Why does it exist?

Imagine two proposals competing for the same two engineers: a new feature projected to generate $500k in revenue, and a reliability program described as "making the system more robust". The feature wins automatically, not because it is more valuable, but because it has a number and the reliability program does not. The reliability program might actually be worth more — it might prevent $700k in outage losses — but because that value was never quantified, it is invisible to the decision, which is made by comparing numbers.

The business case exists to make engineering value visible in the currency of decisions. It converts "more reliable" into "prevents an estimated $540k in expected outage losses over two quarters", which can then compete with the feature's $500k. It exists because, in any organisation that allocates finite resources, the investments that get funded are the ones that can show a return, and engineering work that cannot articulate its return is systematically underfunded relative to its actual value.

#### Mental model

Imagine two doctors recommending treatments. The first says "this surgery will make you healthier" — vague, hard to weigh against the cost and risk. The second says "without this surgery, you have a 40% chance of a heart attack in five years costing you your mobility; with it, that drops to 5%; the surgery costs X and recovery is N weeks" — quantified risk, quantified benefit, a decision you can actually make. A business case is the second doctor's framing applied to engineering: not "it'll be better" but "here is the quantified cost of not doing it, the quantified benefit of doing it, and the return". The vague version loses to anything quantified; the quantified version can be weighed and funded.

#### How it works

The components of a business case:

**ROI (return on investment).** The core: what you get back versus what you put in. `ROI = (benefit - cost) / cost`. For engineering work, the benefit is often avoided cost (outages prevented, toil eliminated, lead-time saved) rather than new revenue, but it is still a return. Express the payback period too: "pays for itself in N months".

**Cost of delay.** What it costs to *not* do this now, per unit time. This is often the most powerful framing for engineering work, because it quantifies the ongoing bleed of inaction. "Every month we delay the CI improvement, the team loses ~200 engineer-hours to slow builds" or "every month without the reliability fix, we risk another $45k/hour outage". Cost of delay turns "we should do this eventually" into "delay is actively expensive".

**Risk reduction value.** For reliability and security work, the benefit is reducing the probability or impact of a bad event. Quantify it as expected value: `risk value = probability of event × cost of event`. "A payment outage has ~$45k/hour cost; we have ~3/quarter at ~2.3 hours each; the program cuts that ~80%, so it saves ~0.8 × 3 × 2.3 × $45k ≈ $248k/quarter in expected losses." Reducing a risk has a dollar value even though the event has not happened yet.

**Opportunity cost.** What else the same resources could do. Every investment is also a decision not to do something else, and a good business case acknowledges this honestly: "these two engineers could instead build feature X worth ~$Y; we argue the reliability work's ~$Z return exceeds it because the outages are worsening and threaten the revenue the features generate". Acknowledging opportunity cost makes the case credible, not weaker.

```text
Business case = 
  Cost (engineer-time, infra, opportunity cost) 
  vs 
  Benefit (new revenue, OR avoided cost, OR risk reduction value)
  expressed as ROI + payback period + cost of delay.
Make the engineering value VISIBLE in the currency of the decision.
```

#### Practical example

The reliability program from 56.2, with the business case worked out. **Cost:** 2 engineers × 2 quarters ≈ $180k (fully loaded), plus the opportunity cost of a ~$500k feature those engineers could build instead. **Benefit (risk reduction value):** payment outages cost ~$45k/hour; the company has had ~3/quarter averaging ~2.3 hours, a worsening trend; the program (dedicated DB + resilience library + alerts) cuts outage frequency and duration by an estimated ~80%. Expected outage cost next two quarters without the program: ~3/quarter × 2.3 hours × $45k × 2 quarters ≈ $620k, worsening. With the program: ~$124k. **Avoided loss ≈ $496k.** **ROI:** ($496k − $180k) / $180k ≈ 175%; payback after preventing ~1.5 outages (a few weeks into the program). **Cost of delay:** every quarter of delay risks another ~$310k in expected outages, worsening into peak season. **Opportunity cost:** honestly, the $500k feature — but the case argues the reliability work protects the revenue all features depend on (an outage during peak season would dwarf one feature's value). The qualitative "make it more reliable" is now a quantified ~175% ROI with a weeks-long payback and a concrete cost of delay, which can win against the feature's $500k because it is both comparable in magnitude and protects the platform the feature runs on.

#### Artifact example

A one-page business case with worked numbers — the artifact that turns engineering value into a fundable decision.

```markdown
# Business case: payment reliability program

## The ask
2 engineers, 2 quarters (~$180k fully loaded).

## The benefit (risk reduction value — the money math)
- Cost per payment-outage hour: ~$45k (lost orders + churn + support).
- Current rate: ~3 outages/quarter × ~2.3 hrs = ~6.9 outage-hours/quarter.
- Trend: WORSENING (traffic growing into peak season; root cause is structural).
- Expected outage cost over next 2 quarters WITHOUT program:
  6.9 hrs × $45k × 2 quarters ≈ $620k (conservative; ignores worsening).
- Program cuts frequency + duration ~80% -> expected cost WITH program ≈ $124k.
- AVOIDED LOSS ≈ $496k.

## ROI and payback
- ROI = ($496k − $180k) / $180k ≈ 175%.
- Payback: after preventing ~1.5 outages (a few weeks in).

## Cost of delay
Every quarter we wait risks ~$310k in expected outages, worsening. Delay is
not neutral — it is actively expensive, and the risk rises into peak season.

## Opportunity cost (honest)
These 2 engineers could build Feature X (~$500k projected). We recommend the
reliability work anyway: it has comparable return (~$496k avoided) AND
protects the revenue ALL features depend on. A peak-season payment outage
would cost far more than Feature X earns.

## Sensitivity (so the numbers are credible, not cherry-picked)
Even if we're 50% too optimistic (avoided loss = $248k), ROI is still ~38%
and payback is under a quarter. The case holds under pessimistic assumptions.
```

The business case's power is that it quantifies the previously-qualitative ("more reliable") into risk reduction value, ROI, payback, and cost of delay — all in dollars — and it does three things that make it credible: it honestly names the opportunity cost (the $500k feature) and argues past it, it shows cost of delay (inaction is expensive), and it includes a sensitivity analysis showing the case holds even under pessimistic assumptions. That sensitivity analysis is what distinguishes a defensible business case from cherry-picked advocacy, and it is what a finance partner trusts.

#### Real-world scenario

A principal engineer repeatedly loses funding arguments for platform and reliability work to features, despite believing the engineering work is more valuable. She changes her approach: she stops arguing in qualitative terms and starts building quantified business cases. For the platform work, she measures the toil it would eliminate (engineer-hours/week across teams) and the lead-time it would save, converts those to dollars, and shows the ROI. For reliability, she computes risk reduction value from actual outage costs. The effect is immediate and dramatic: the same work that lost every argument when described as "we should improve our platform" now wins, because it arrives as "this saves ~400 engineer-hours/month across teams, ~$X/year, ROI ~Y%, payback in Z months". The finance partners, who could not weigh "improve the platform" against a feature's revenue, can easily weigh "$X/year saved" against it. Nothing about the underlying work changed; the quantification made its value visible in the currency of the decision. The lesson: engineering work is not underfunded because it is less valuable; it is underfunded because its value is usually left unquantified, and the fix is to do the quantification work that features get for free.

#### Edge cases & failure modes

- **No business case at all.** "It'll be better" loses to any feature with a number, regardless of actual value.
- **Cherry-picked optimistic numbers.** A case with only best-case assumptions and no sensitivity analysis gets distrusted and dismissed by finance.
- **Ignoring opportunity cost.** A case that pretends the resources were free is less credible; honestly naming and arguing past the opportunity cost is stronger.
- **No cost of delay.** Without quantifying the bleed of inaction, "we should do this eventually" never becomes "now", and the work is perpetually deferred.
- **False precision.** Presenting rough estimates as exact ($496,213) signals you do not understand they are estimates; use round numbers and ranges and state assumptions.
- **Quantifying the unquantifiable badly.** Forcing a dubious number onto something genuinely hard to quantify (morale, strategic optionality) can backfire; sometimes acknowledge a benefit is qualitative while quantifying what you can.

#### How a Principal Engineer thinks about this

They treat the business case as the price of admission for any engineering investment that must compete for funding, and they internalise that engineering work is not underfunded because it is less valuable but because its value is usually left unquantified while features arrive with numbers. So they do the quantification work features get for free: converting reliability into risk reduction value, platform into avoided toil and saved lead-time, tech debt into cost of delay — all in dollars, in the currency of the decision.

They make their cases *credible* rather than merely favourable, because they know a cherry-picked case gets distrusted: they include the opportunity cost honestly and argue past it, they show the cost of delay so inaction looks expensive, and above all they include a sensitivity analysis showing the case holds even under pessimistic assumptions — which is what converts a finance partner from skeptic to supporter. They use round numbers and ranges rather than false precision, because they respect that these are estimates. The principal's skill is not inflating the numbers; it is finding the honest numbers that make real engineering value visible, so that work worth doing actually gets funded.

#### Common mistakes

- **Arguing qualitatively** ("it'll be better") and losing to any quantified feature.
- **Cherry-picking optimistic numbers** with no sensitivity analysis, getting distrusted.
- **Ignoring opportunity cost,** which makes the case less credible.
- **Omitting cost of delay,** so the work is perpetually deferred as "eventually".
- **False precision,** presenting rough estimates as exact figures.

#### Interview questions

1. **How do you build a business case for engineering work that doesn't directly generate revenue, like reliability or platform?**
   *Expected answer:* quantify the benefit as avoided cost or risk reduction value (probability × cost of event), express it as ROI and payback period, show the cost of delay (the ongoing bleed of inaction), honestly state the opportunity cost, and include a sensitivity analysis showing it holds under pessimistic assumptions. Make the value visible in dollars, the currency of the decision. *Follow-up:* how do you compute risk reduction value.

2. **Why include a sensitivity analysis and the opportunity cost in a business case?**
   *Expected answer:* a case with only optimistic numbers gets distrusted and dismissed by finance; showing it holds even under pessimistic assumptions (sensitivity) makes it credible, and honestly naming the opportunity cost (what else the resources could do) and arguing past it makes the case stronger, not weaker, because it shows you have weighed the alternative. *Why it matters:* tests whether they build credible cases or advocacy.

3. **Your platform work keeps losing funding to features. Why, and what do you do?**
   *Expected answer:* because features arrive with revenue numbers and the platform work is described qualitatively, so its value is invisible in the comparison. Quantify it — measure the toil it eliminates and the lead-time it saves, convert to dollars, show ROI and payback — so it competes in the same currency. The work is not less valuable; its value is unquantified. *Why it matters:* this is the central business-case insight.

#### Practical exercise

Build a business case for a piece of non-feature engineering work you believe in (reliability, platform, tech debt). Quantify the benefit in dollars — as avoided cost, risk reduction value (probability × cost of event), or saved engineer-time/lead-time. Compute the ROI and payback period. State the cost of delay (what inaction costs per unit time). Honestly name the opportunity cost. And add a sensitivity analysis showing the case holds if your numbers are, say, 50% too optimistic.

**Acceptance criteria:** the benefit is quantified in dollars (not "it'll be better"), using avoided cost or risk reduction value with stated assumptions; you compute ROI and payback; you quantify the cost of delay so inaction looks expensive; you name the opportunity cost and argue past it; and your sensitivity analysis shows the case still holds under pessimistic (e.g. halved-benefit) assumptions, making it credible rather than cherry-picked.
