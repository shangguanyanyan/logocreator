import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import dedent from "dedent";
import Replicate from "replicate";
import { z } from "zod";

let ratelimit: Ratelimit | undefined;

export async function POST(req: Request) {
  const user = await currentUser();

  if (!user) {
    return new Response("", { status: 404 });
  }

  const json = await req.json();
  const data = z
    .object({
      userAPIKey: z.string().optional(),
      companyName: z.string(),
      selectedLayout: z.string(),
      selectedStyle: z.string(),
      selectedPrimaryColor: z.string(),
      selectedBackgroundColor: z.string(),
      additionalInfo: z.string().optional(),
    })
    .parse(json);

  // Add rate limiting if Upstash API keys are set & no BYOK, otherwise skip
  if (process.env.UPSTASH_REDIS_REST_URL && !data.userAPIKey) {
    ratelimit = new Ratelimit({
      redis: Redis.fromEnv(),
      // Allow 3 requests per 2 months on prod
      limiter: Ratelimit.fixedWindow(3, "60 d"),
      analytics: true,
      prefix: "logocreator",
    });
  }

  const client = new Replicate({
    auth: data.userAPIKey || process.env.REPLICATE_API_TOKEN,
  });

  if (data.userAPIKey) {
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining: "BYOK",
      },
    });
  }

  if (ratelimit) {
    const identifier = user.id;
    const { success, remaining } = await ratelimit.limit(identifier);
    (await clerkClient()).users.updateUserMetadata(user.id, {
      unsafeMetadata: {
        remaining,
      },
    });

    if (!success) {
      return new Response(
        "You've used up all your credits. Enter your own Replicate API Key to generate more logos.",
        {
          status: 429,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }
  }

  const flashyStyle =
    "Flashy, attention grabbing, bold, futuristic, and eye-catching. Use vibrant neon colors with metallic, shiny, and glossy accents.";

  const techStyle =
    "highly detailed, sharp focus, cinematic, photorealistic, Minimalist, clean, sleek, neutral color pallete with subtle accents, clean lines, shadows, and flat.";

  const modernStyle =
    "modern, forward-thinking, flat design, geometric shapes, clean lines, natural colors with subtle accents, use strategic negative space to create visual interest.";

  const playfulStyle =
    "playful, lighthearted, bright bold colors, rounded shapes, lively.";

  const abstractStyle =
    "abstract, artistic, creative, unique shapes, patterns, and textures to create a visually interesting and wild logo.";

  const minimalStyle =
    "minimal, simple, timeless, versatile, single color logo, use negative space, flat design with minimal details, Light, soft, and subtle.";

  const styleLookup: Record<string, string> = {
    Flashy: flashyStyle,
    Tech: techStyle,
    Modern: modernStyle,
    Playful: playfulStyle,
    Abstract: abstractStyle,
    Minimal: minimalStyle,
  };

  const layoutLookup: Record<string, string> = {
    Solo: "single centered logo with the company name integrated within or positioned elegantly below the logo symbol",
    Side: "horizontal layout with the logo symbol on the left side and company name text on the right side", 
    Stack: "vertical stacked layout with the logo symbol positioned above and company name text positioned below"
  };

  const prompt = dedent`A single logo, high-quality, award-winning professional design, made for both digital and print media, only contains a few vector shapes, ${styleLookup[data.selectedStyle]}

Layout style: ${layoutLookup[data.selectedLayout] || layoutLookup.Solo}. Primary color is ${data.selectedPrimaryColor.toLowerCase()} and background color is ${data.selectedBackgroundColor.toLowerCase()}. The company name is ${data.companyName}, make sure to include the company name in the logo. ${data.additionalInfo ? `Additional info: ${data.additionalInfo}` : ""}`;

  try {
    const output = await client.run(
      "black-forest-labs/flux-1.1-pro",
      {
        input: {
          prompt,
          width: 768,
          height: 768,
          output_format: "webp",
          output_quality: 80,
        }
      }
    );

    // Convert the output URL to base64 for consistency with original API
    const imageUrl = Array.isArray(output) ? (output[0] as any).url() : (output as any).url();
    const response = await fetch(imageUrl);
    
    if (!response.ok) {
      throw new Error("Failed to download generated image");
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Convert to base64 without using Node.js Buffer (Edge Runtime compatible)
    const base64 = btoa(String.fromCharCode.apply(null, Array.from(uint8Array)));
    
    return Response.json({ 
      b64_json: base64,
      revised_prompt: prompt 
    }, { status: 200 });
  } catch (error) {
    const invalidApiKey = z
      .object({
        detail: z.string().includes("Invalid API token"),
      })
      .safeParse(error);

    if (invalidApiKey.success) {
      return new Response("Your API key is invalid.", {
        status: 401,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const insufficientCredits = z
      .object({
        detail: z.string().includes("insufficient credits"),
      })
      .safeParse(error);

    if (insufficientCredits.success) {
      return new Response(
        "Your Replicate account has insufficient credits. Please add credits at: https://replicate.com/account/billing",
        {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }

    throw error;
  }
}

export const runtime = "edge";
