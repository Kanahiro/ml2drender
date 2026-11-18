#!/bin/sh
# Usage: pr-comment.sh <pr number> <key> <body file>
# Creates the PR comment tagged with <key>, or updates it in place. CI uses this so that each
# workflow keeps its own comment (gh's --edit-last would edit whichever bot comment came last).
set -eu
pr=$1 key=$2 file=$3
marker="<!-- ml2drender:$key -->"
{ echo "$marker"; cat "$file"; } > "$file.comment"
id=$(gh api "repos/$GITHUB_REPOSITORY/issues/$pr/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | tail -n 1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GITHUB_REPOSITORY/issues/comments/$id" -F "body=@$file.comment" > /dev/null
else
  gh pr comment "$pr" --repo "$GITHUB_REPOSITORY" --body-file "$file.comment"
fi
