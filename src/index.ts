import express, { Request, Response } from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import cors from 'cors';
import { z } from 'zod';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const ComplianceSchema = z.object({
  vendorName: z.string(),
  documentType: z.enum(['W9', 'InsuranceCertificate', 'Unknown']),
  extractedDate: z.string().nullable(),
  hasSignature: z.boolean(),
  coverageAmountUSD: z.number().nullable().optional(),
  isValid: z.boolean(),
  issuesFlagged: z.array(z.string()),
});

type ComplianceResult = z.infer<typeof ComplianceSchema>;

async function parsePdfBuffer(buffer: Buffer): Promise<string> {
  const { PdfReader } = await import('pdfreader');
  
  return new Promise((resolve, reject) => {
    let extractedText = '';
    new PdfReader({}).parseBuffer(buffer, (err: any, item: any) => {
      if (err) {
        reject(err);
      } else if (!item) {
        resolve(extractedText);
      } else if (item.text) {
        extractedText += item.text + ' ';
      }
    });
  });
}

async function extractDocumentData(fileBuffer: Buffer, mimeType: string): Promise<string> {
  if (mimeType === 'application/pdf' || mimeType.includes('pdf')) {
    console.log("⚡ [STAGE A: EXTRACTION] Parsing native PDF buffer local matrix...");
    const text = await parsePdfBuffer(fileBuffer);
    return text || 'Empty PDF content';
  }

  console.log("⚡ [STAGE A: EXTRACTION] Image detected. Initiating OpenRouter multimodal routing node...");
  const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
  const base64Data = fileBuffer.toString('base64');
  
  const response = await fetch(openRouterUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openrouter/free',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract all explicit business vendor parameters out of this document frame.'
            },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64Data}` }
            }
          ]
        }
      ]
    })
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

async function auditCompliance(rawExtractedText: string): Promise<ComplianceResult> {
  console.log("📡 [STAGE B: COMPLIANCE] Invoking agentic evaluation prompts across target business boundaries...");
  const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
  
  const systemPrompt = `You are an expert compliance auditor assessing corporate data text blocks. Evaluate variables matching these thresholds:
  1. Classify document profile type explicitly as 'W9', 'InsuranceCertificate', or 'Unknown'.
  2. W9 documents must have signature references verified.
  3. Insurance Certificates must explicitly indicate a policy threshold equal or exceeding 1,000,000 USD.
  Format the output string explicitly to a verified single JSON payload conforming strictly to this pattern:
  {
    "vendorName": "Company Name",
    "documentType": "W9" | "InsuranceCertificate" | "Unknown",
    "extractedDate": "YYYY-MM-DD or null",
    "hasSignature": true/false,
    "coverageAmountUSD": number or null,
    "isValid": true/false,
    "issuesFlagged": ["reasons why validation flags dropped"]
  }`;

  const response = await fetch(openRouterUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openrouter/free',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the targeted context block: \n\n${rawExtractedText}` }
      ],
      response_format: { type: 'json_object' }
    })
  });

  const data = await response.json();
  let rawContent = data.choices[0].message.content;
  rawContent = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();

  return ComplianceSchema.parse(JSON.parse(rawContent));
}

app.post('/api/verify-document', upload.single('document'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Payload body buffer vector missing.' });
      return;
    }

    const rawData = await extractDocumentData(req.file.buffer, req.file.mimetype);
    const auditReport = await auditCompliance(rawData);

    console.log(`✅ [AUDIT COMPLETE] System generated report successfully for: ${auditReport.vendorName}`);
    res.status(200).json({ success: true, report: auditReport });
  } catch (error: any) {
    console.error('❌ Pipeline operational runtime crash:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`\n🛸 ====================================================== 🛸`);
  console.log(`📡 ContractFlow AI operational agent active on port ${PORT}`);
  console.log(`🛸 ====================================================== 🛸\n`);
});