# Deployment Guide — Harvey PK

## Required Environment Variables

Set all of the following in your Vercel project settings under **Settings → Environment Variables**.

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (from Supabase → Project Settings → API) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_KEY` | Supabase service-role key — server-side only, never expose to client |
| `OPENAI_API_KEY` | OpenAI API key for embeddings, GPT-4o, TTS, Whisper |
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude (Deep Research mode) |

> **Security note:** `SUPABASE_SERVICE_KEY` and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` must **not** be prefixed with `NEXT_PUBLIC_`. They are used exclusively in server-side API routes and are never sent to the browser.

---

## Deploying to Vercel

### 1. Import the repository

1. Go to [vercel.com/new](https://vercel.com/new).
2. Import your GitHub repository.
3. Framework preset will be detected as **Next.js** automatically.

### 2. Configure environment variables

In the Vercel project settings, add each variable from the table above for **Production**, **Preview**, and **Development** environments as appropriate.

### 3. Deploy

Click **Deploy**. Vercel will run `npm run build` and deploy on success.

### 4. Subsequent deployments

Push to your main branch — Vercel redeploys automatically.

---

## Custom Domain — DNS Records

In your DNS provider, add the following records to point your domain to Vercel:

### Apex domain (e.g. `harveypk.com`)

| Type | Name | Value |
|---|---|---|
| `A` | `@` | `76.76.21.21` |

### Subdomain (e.g. `app.harveypk.com`)

| Type | Name | Value |
|---|---|---|
| `CNAME` | `app` | `cname.vercel-dns.com` |

After adding DNS records, add the custom domain in **Vercel → Project → Settings → Domains** and Vercel will provision an SSL certificate automatically via Let's Encrypt.

> DNS propagation typically takes a few minutes but can take up to 48 hours depending on your provider's TTL settings.

---

## Post-deployment checklist

- [ ] Confirm all environment variables are set in Vercel
- [ ] Test sign-in at `/login`
- [ ] Test a chat message in Fast mode (OpenAI)
- [ ] Test a chat message in Deep Research mode (Claude)
- [ ] Test document upload in the Admin corpus panel
- [ ] Verify Supabase RLS policies are active (check `user_roles` table)
- [ ] Add custom domain and verify SSL certificate is issued
