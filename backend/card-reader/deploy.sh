#!/usr/bin/env bash
# Builds and deploys the InfoCapture card reader with CloudFormation.
#
#   TENANT_ID=... CLIENT_ID=... ARTIFACT_BUCKET=my-bucket ./deploy.sh
#
# Uses the AWS CLI profile tlc-tech in us-east-2 unless AWS_PROFILE or
# AWS_REGION say otherwise (the default profile is left alone). Optional:
# STACK_NAME, ALLOWED_ORIGINS, CLAUDE_MODEL, SECRET_NAME. Store the API key
# first with ./set-key.sh.
set -euo pipefail
cd "$(dirname "$0")"

: "${TENANT_ID:?Set TENANT_ID to your Entra tenant ID}"
: "${CLIENT_ID:?Set CLIENT_ID to the app registration client ID}"
: "${ARTIFACT_BUCKET:?Set ARTIFACT_BUCKET to an S3 bucket for the code package}"
PROFILE="${AWS_PROFILE:-tlc-tech}"
REGION="${AWS_REGION:-us-east-2}"
STACK="${STACK_NAME:-infocapture-card-reader}"
ORIGINS="${ALLOWED_ORIGINS:-https://travis-tlctech.github.io}"
MODEL="${CLAUDE_MODEL:-claude-opus-5-5}"
SECRET="${SECRET_NAME:-infocapture/anthropic-api-key}"
AWS=(aws --profile "$PROFILE" --region "$REGION")

# Metadata check only; the key's value is never read here.
if ! "${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET" >/dev/null 2>&1; then
  echo "No secret named $SECRET in $REGION (profile $PROFILE). Run ./set-key.sh first." >&2
  exit 1
fi

npm ci
npm test
npm run build

"${AWS[@]}" cloudformation package \
  --template-file template.yaml \
  --s3-bucket "$ARTIFACT_BUCKET" \
  --s3-prefix infocapture-card-reader \
  --output-template-file packaged.yaml

"${AWS[@]}" cloudformation deploy \
  --stack-name "$STACK" \
  --template-file packaged.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    TenantId="$TENANT_ID" \
    ClientId="$CLIENT_ID" \
    AllowedOrigins="$ORIGINS" \
    ClaudeModel="$MODEL" \
    ApiKeySecretName="$SECRET"

echo
echo "Card reader URL (put this in app/config.js as cardReaderUrl):"
"${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CardReaderUrl'].OutputValue" --output text
