#!/usr/bin/env bash
# Builds and deploys the InfoCapture card reader with CloudFormation.
#
#   TENANT_ID=... CLIENT_ID=... ARTIFACT_BUCKET=my-bucket ./deploy.sh
#
# Optional: AWS_REGION (default us-east-2), STACK_NAME, ALLOWED_ORIGINS,
# CLAUDE_MODEL. The Anthropic API key must already be in SSM (see README).
set -euo pipefail
cd "$(dirname "$0")"

: "${TENANT_ID:?Set TENANT_ID to your Entra tenant ID}"
: "${CLIENT_ID:?Set CLIENT_ID to the app registration client ID}"
: "${ARTIFACT_BUCKET:?Set ARTIFACT_BUCKET to an S3 bucket for the code package}"
REGION="${AWS_REGION:-us-east-2}"
STACK="${STACK_NAME:-infocapture-card-reader}"
ORIGINS="${ALLOWED_ORIGINS:-https://travis-tlctech.github.io}"
MODEL="${CLAUDE_MODEL:-claude-opus-5-5}"

npm ci
npm test
npm run build

aws cloudformation package \
  --region "$REGION" \
  --template-file template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix infocapture-card-reader \
  --output-template-file packaged.yaml

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file packaged.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    TenantId="$TENANT_ID" \
    ClientId="$CLIENT_ID" \
    AllowedOrigins="$ORIGINS" \
    ClaudeModel="$MODEL"

echo
echo "Card reader URL (put this in app/config.js as cardReaderUrl):"
aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CardReaderUrl'].OutputValue" --output text
