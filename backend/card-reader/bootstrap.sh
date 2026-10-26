#!/usr/bin/env bash
# One-time setup so the card reader can be deployed from GitHub Actions with
# no AWS keys stored anywhere. Creates the stack infocapture-deploy-access:
# an S3 bucket for code packages and the role infocapture-github-deploy, which
# only this repository's "card-reader" GitHub environment can use, limited to
# the card reader's own resources (see bootstrap.yaml).
#
#   ./bootstrap.sh
#
# Uses the AWS CLI profile tlc-tech in us-east-2 unless AWS_PROFILE or
# AWS_REGION say otherwise (the default profile is left alone). Safe to run
# again.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${AWS_PROFILE:-tlc-tech}"
REGION="${AWS_REGION:-us-east-2}"
REPO="${GITHUB_REPO:-travis-tlctech/infocapture}"
STACK=infocapture-deploy-access
AWS=(aws --profile "$PROFILE" --region "$REGION")

ACCOUNT="$("${AWS[@]}" sts get-caller-identity --query Account --output text)"
echo "AWS account $ACCOUNT, profile $PROFILE, region $REGION"

# Reuse the account's GitHub identity provider if another project added it,
# unless this stack created it on an earlier run.
PROVIDER="$("${AWS[@]}" iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?ends_with(Arn, '/token.actions.githubusercontent.com')].Arn | [0]" --output text)"
OURS="$("${AWS[@]}" cloudformation describe-stack-resources --stack-name "$STACK" --logical-resource-id GitHubOidcProvider \
  --query "StackResources[0].PhysicalResourceId" --output text 2>/dev/null || true)"
if [ "$PROVIDER" = None ] || { [ -n "$OURS" ] && [ "$OURS" != None ]; }; then PROVIDER=""; fi

"${AWS[@]}" cloudformation deploy \
  --stack-name "$STACK" \
  --template-file bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides GitHubRepo="$REPO" ExistingOidcProviderArn="$PROVIDER"

"${AWS[@]}" cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs" --output table
echo
echo "Done. Post the account number $ACCOUNT on S1.4 in Asana (it is not a secret)."
