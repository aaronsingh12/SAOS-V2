import { NextRequest, NextResponse } from "next/server";
import { selectedModel, installedModels, explainWithLocalModel, localBaseUrl } from "@/lib/ai/local";
import { getAllMasterRules, getMasterRule, searchMasterRules, type MasterRule } from "@/lib/rules/catalog";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      messages?: { role: "user" | "assistant" | "system"; content: string }[];
    };

    const messages = body.messages ?? [];
    if (messages.length === 0) {
      return NextResponse.json({ error: "No messages provided" }, { status: 400 });
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUserMessage?.content || "";

    // 1. Identify specific rule IDs or keywords mentioned in the user's prompt
    const ruleIdRegex = /\b((?:CMDB|ITSM|ITOM|CSDM|DQ|PLT|SEC)[-_]?\d+)\b/gi;
    const matches = query.match(ruleIdRegex) || [];
    const matchedRules: MasterRule[] = [];

    for (const rawMatch of matches) {
      const normalized = rawMatch.toUpperCase().replace("_", "-");
      const found = getMasterRule(normalized);
      if (found && !matchedRules.some((r) => r.id === found.id)) {
        matchedRules.push(found);
      }
    }

    // If no explicit ID, search by semantic keywords
    if (matchedRules.length === 0 && query.trim().length > 2) {
      const searchResults = searchMasterRules(query);
      for (const r of searchResults.slice(0, 3)) {
        if (!matchedRules.some((m) => m.id === r.id)) {
          matchedRules.push(r);
        }
      }
    }

    // 2. Build Rule Knowledge Dossier for Context Injection
    let ruleContextText = "";
    if (matchedRules.length > 0) {
      ruleContextText = `
### RELEVANT MASTER CATALOG RULE DEFINITIONS (${matchedRules.length} matched):
${matchedRules
  .map(
    (r) => `
- **Rule ID**: [${r.id}] ${r.title}
  - **Domain**: ${r.domain} | **Base Severity**: ${r.baseSeverity} | **Remediation Lane**: Lane ${r.remediationLane} (${r.remediationLane === 1 ? "Reversible Update Set / Flag" : r.remediationLane === 2 ? "Direct Configuration Mutation / Patch" : "Architectural / Business Rule"})
  - **What It Means**: ${r.whatItMeans}
  - **Why It Matters (Blast Radius)**: ${r.whyItMatters}
  - **Source Tables**: ${r.sourceTables}
  - **Detection Logic**: ${r.detectionLogic || "Evaluates CMDB / ITSM table attributes"}
  - **Threshold / Confidence Basis**: ${r.threshold || "Absolute violation"} | ${r.confidenceBasis || "Deterministic DB query"}
  - **False Positive Guard**: ${r.falsePositiveGuard || "Active record verification"}
  - **Remediation Strategy**: ${r.rawRemediationLane || "Automate via SAOS Update Set or direct REST mutation"}
`,
  )
  .join("\n")}
`;
    }

    // 3. Detect language comfort (Hinglish/Hindi vs English)
    const isHinglish =
      /\b(kya|kaise|kyun|batao|samjhao|hai|hota|karein|nuksan|bhi|yaar|sun|dikhe|matlab|sab|isme|kuch|chahiye)\b/i.test(
        query,
      );

    const systemPrompt = `You are the SAOS Rulebook AI Assistant, an elite ServiceNow Enterprise Governance expert architect.
You explain rules from the 755 ServiceNow Master Rulebook (CMDB, ITSM, CSDM 4.0, ITOM, Data Quality).

CRITICAL INSTRUCTIONS:
1. Respond directly to the user. NEVER output your internal thoughts, thinking process, or planning steps.
2. ${isHinglish ? "The user asked in Hindi/Hinglish. Explain in friendly, crystal-clear Hinglish/Hindi so any engineer can easily understand." : "The user asked in English. Provide a professional, clear, and direct explanation."}
3. DO NOT use raw markup like ### or *** in your output. Use clean, natural section headers like:
   - Rule Overview:
   - Why It Matters (Business Impact):
   - Affected ServiceNow Tables:
   - How to Remediate:
4. Keep the explanation direct, crisp, and high-value without unnecessary fluff.

${ruleContextText}`;

    // 4. Query Ollama using conversational /api/chat
    let aiResponse = "";
    let activeModelName = "Master Catalog Engine";
    try {
      const model = await selectedModel();
      if (model) {
        const response = await fetch(`${localBaseUrl()}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: query },
            ],
            stream: false,
            options: { temperature: 0.2 },
          }),
          signal: AbortSignal.timeout(45_000),
        });

        if (response.ok) {
          const resBody = (await response.json()) as {
            message?: { content?: string; thinking?: string };
            response?: string;
          };
          let raw = resBody.message?.content || resBody.response || "";
          
          // Strictly strip <think>...</think> blocks
          raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

          // Filter out any internal chain of thought lines if emitted
          const lines = raw.split("\n");
          const cleanedLines: string[] = [];
          for (const line of lines) {
            const t = line.trim();
            if (
              /^(1\.|2\.|3\.|4\.|5\.)\s+(The user is asking|I need to|The rule definition|Structure:|Let's)/i.test(t) ||
              /^Thinking Process:/i.test(t) ||
              /^(First,|Next,|Finally,|Okay, let me)\s+/i.test(t) ||
              /^I will (explain|format|provide|use|respond)\b/i.test(t)
            ) {
              continue;
            }
            cleanedLines.push(line);
          }
          const cleaned = cleanedLines.join("\n").trim();

          // Only accept if it's a real response and not just a fragment or thought
          if (cleaned.length > 60 && !cleaned.toLowerCase().startsWith("let's")) {
            aiResponse = cleaned;
            activeModelName = model;
          }
        }
      }
    } catch (err) {
      console.warn("Local Ollama chat failed or model unavailable, using smart catalog synthesis:", err);
    }

    // 5. If model didn't return a clean response, provide rich, deterministic catalog synthesis
    if (!aiResponse || aiResponse.trim().length === 0) {
      if (matchedRules.length > 0) {
        const rule = matchedRules[0];
        if (isHinglish) {
          aiResponse = `Rule Overview: [${rule.id}] ${rule.title}
Domain: ${rule.domain} | Base Severity: ${rule.baseSeverity}

Kya karta hai yeh rule?
${rule.whatItMeans}

Kyun important hai? (Business Impact & Blast Radius)
${rule.whyItMatters}
Agar ise fix na kiya jaye toh incident routing aur outage correlation break ho sakti hai, aur governance compliance me audit gap flag hota hai.

ServiceNow Tables:
${rule.sourceTables}

Remediation Strategy:
Yeh Lane ${rule.remediationLane} governance rule hai.
${rule.rawRemediationLane || "Aap SAOS Problems tab me is rule ke individual records inspect karke direct reversible Update Set apply kar sakte hain."}`;
        } else {
          aiResponse = `Rule Overview: [${rule.id}] ${rule.title}
Domain: ${rule.domain} | Base Severity: ${rule.baseSeverity}

What It Means:
${rule.whatItMeans}

Why It Matters (Business Impact & Blast Radius):
${rule.whyItMatters}
Leaving this unaddressed leads to incident routing confusion, delayed MTTR, and compliance flags during ServiceNow audits.

Target ServiceNow Tables:
${rule.sourceTables}

Remediation Strategy:
Classified under Lane ${rule.remediationLane} governance.
${rule.rawRemediationLane || "You can inspect individual records in the SAOS Problems tab and stage an automated, reversible Update Set."}`;
        }
      } else {
        if (isHinglish) {
          aiResponse = `Main SAOS Autonomous Rulebook AI Assistant hoon!

Aap mujhse 755 Master ServiceNow Rules ke bare me kuch bhi pooch sakte hain:
- CMDB-106 kya hai aur CSDM services me owner kyun zaruri hai?
- ITSM-033 SLA breach ka kya business impact hota hai?
- CMDB-058 Orphan CIs ko kaise fix karein?
- ITOM discovery stale records ko kaise resolve karein?

Aap koi bhi Rule ID ya topic likh kar puchein, main seedha explain karunga!`;
        } else {
          aiResponse = `I am the SAOS Autonomous Rulebook AI Assistant!

You can ask me about any of the 755 Master ServiceNow Governance Rules:
- What is CMDB-106 and why do CSDM services require designated owners?
- What is the operational risk of ITSM-033 SLA breaches?
- How to remediate CMDB-058 Orphan CIs?
- How to handle ITOM stale discovery schedules?

Ask about any rule code or governance topic to get an instant explanation.`;
        }
      }
    }

    return NextResponse.json({
      role: "assistant",
      content: aiResponse,
      model: activeModelName,
      matchedRules: matchedRules.map((r) => ({
        id: r.id,
        title: r.title,
        domain: r.domain,
        baseSeverity: r.baseSeverity,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Rulebook AI chat API error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to process chat query" },
      { status: 500 },
    );
  }
}
