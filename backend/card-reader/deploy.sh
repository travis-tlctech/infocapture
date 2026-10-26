#!/usr/bin/env bash
# Builds and deploys the InfoCapture card reader with CloudFormation.
#
#   ./deploy.sh
#
# Reads the Supabase project URL and publishable key from app/config.js
# (override with SUPABASE_URL and SUPABASE_KEY). Uses the AWS CLI profile
# tlc-tech in us-east-2 unless AWS_PROFILE or AWS_REGION say otherwise (the
# default profile is left alone). In GitHub Actions, AWS_CREDENTIALS_FROM_ENV=1
# uses the deploy role's short-lived credentials instead. The code package goes
# to ARTIFACT_BUCKET, by default the bucket bootstrap.sh created. Optional:
# STACK_NAME, ALLOWED_ORIGINS, CLAUDE_MODEL, SECRET_NAME. Store the API key
# first with ./set-key.sh.
set -euo pipefail
cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-2}"
if [ "${AWS_CREDENTIALS_FROM_ENV:-}" = 1 ]; then
  AWS=(aws --region "$REGION")
  WHO="the credentials in the environment"
else
  PROFILE="${AWS_PROFILE:-tlc-tech}"
  AWS=(aws --profile "$PROFILE" --region "$REGION")
  WHO="profile $PROFILE"
fi
STACK="${STACK_NAME:-infocapture-card-reader}"
ORIGINS="${ALLOWED_ORIGINS:-https://travis-tlctech.github.io}"
MODEL="${CLAUDE_MODEL:-claude-opus-5-5}"
SECRET="${SECRET_NAME:-infocapture/anthropic-api-key}"

config() { node --input-type=module -e "const c = (await import('./../../app/config.js')).default; process.stdout.write(c['$1'] ?? '')"; }
SUPABASE_URL="${SUPABASE_URL:-$(config supabaseUrl)}"
SUPABASE_KEY="${SUPABASE_KEY:-$(config supabaseKey)}"
if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ]; then
  echo "Set supabaseUrl and supabaseKey in app/config.js (or SUPABASE_URL and SUPABASE_KEY)." >&2
  exit 1
fi

ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
BUCKET="${ARTIFACT_BUCKET:-infocapture-deploy-$ACCOUNT-$REGION}"
echo "Deploying $STACK to account $ACCOUNT ($REGION) with $WHO"

# Metadata check only; the key's value is never read here.
if ! "${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  echo "No secret named $SECRET in $REGION. Run ./set-key.sh first." >&2
  exit 1
fi

npm ci
npm test
npm run build

"${AWS[@]}" cloudformation package \
  --template-file template.yaml \
  --s3-bucket "$BUCKET" \
  --s3-prefix infocapture-card-reader \
  --output-template-file packaged.yaml

"${AWS[@]}" cloudformation deploy \
  --stack-name "$STACK" \
  --template-file packaged.yaml \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    SupabaseUrl="$SUPABASE_URL" \
    SupabasePublishableKey="$SUPABASE_KEY" \
    AllowedOrigins="$ORIGINS" \
    ClaudeModel="$MODEL" \
    ApiKeySecretName="$SECRET"

URL="$("${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CardReaderUrl'].OutputValue" --output text)"
echo
echo "Card reader URL (put this in app/config.js as cardReaderUrl):"
echo "$URL"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Card reader deployed\n\nURL: `%s`\n\nPut it in `app/config.js` as `cardReaderUrl`.\n' "$URL" >> "$GITHUB_STEP_SUMMARY"
fi
