#!/usr/bin/env bash
# Stores the Anthropic API key for the card reader in AWS Secrets Manager.
#
#   ./set-key.sh
#
# Run it in the Terminal app, not in a chat box. The key is typed at a hidden
# prompt: it is never echoed, logged, or passed as a command-line argument.
# Running it again replaces the key; the Lambda picks up the new one on its
# next 401 or cold start. Optional: AWS_PROFILE (default tlc-tech),
# AWS_REGION (default us-east-2), SECRET_NAME.
set -euo pipefail

PROFILE="${AWS_PROFILE:-tlc-tech}"
REGION="${AWS_REGION:-us-east-2}"
NAME="${SECRET_NAME:-infocapture/anthropic-api-key}"
AWS=(aws --profile "$PROFILE" --region "$REGION")

# Check the AWS sign-in before asking for the key, so a sign-in problem never
# costs a pasted key.
if ! command -v aws >/dev/null 2>&1; then
  echo "The AWS command-line tool (aws) is not installed on this computer, so nothing was stored." >&2
  exit 1
fi
if ! ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text 2>/dev/null)"; then
  echo "AWS sign-in for profile $PROFILE is not working, so nothing was stored." >&2
  echo "If that profile uses single sign-on, run: aws sso login --profile $PROFILE" >&2
  echo "Then run ./set-key.sh again." >&2
  exit 1
fi
echo "AWS account $ACCOUNT (profile $PROFILE, region $REGION)."

read -rs -p "Paste the info-capture API key (input is hidden), then press Enter: " IC_KEY
echo
if [ ${#IC_KEY} -le 20 ]; then
  unset IC_KEY
  echo "No key was captured, so nothing was stored. Run ./set-key.sh again and paste the key." >&2
  exit 1
fi

if "${AWS[@]}" secretsmanager describe-secret --secret-id "$NAME" >/dev/null 2>&1; then
  printf %s "$IC_KEY" | "${AWS[@]}" secretsmanager put-secret-value --secret-id "$NAME" --secret-string file:///dev/stdin >/dev/null
  action="replaced"
else
  printf %s "$IC_KEY" | "${AWS[@]}" secretsmanager create-secret --name "$NAME" \
    --description "Anthropic API key (info-capture) for the InfoCapture card reader" \
    --secret-string file:///dev/stdin >/dev/null
  action="stored"
fi
unset IC_KEY

echo "Key $action in Secrets Manager. Metadata only (the value is never shown):"
"${AWS[@]}" secretsmanager describe-secret --secret-id "$NAME" \
  --query '{Name:Name,Created:CreatedDate,LastChanged:LastChangedDate,Versions:length(keys(VersionIdsToStages))}' \
  --output table
