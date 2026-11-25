# API tokens

Use a personal API token to connect a script or another tool to Leitwerk. A token grants the same application access as its owner.

## Create a token

1. Open the user menu at the bottom of the sidebar and select **API tokens**.
2. Enter a **Name** that identifies the tool using the token, such as `Release automation`.
3. Choose an **Expiration**. The menu shows the options allowed on your installation. If you choose a date and time, enter it in local time.
4. Click **Create token**. Under **Save your token now**, use **Copy token** and save it securely. The secret appears only once.

If your installation has browser authentication turned off, everyone shares the anonymous token owner and can view and revoke its tokens.

## Authenticate HTTP requests

Send the token in the `Authorization` header as a bearer token. Keep it out of URLs.

```sh
curl --fail -H "Authorization: Bearer $LEITWERK_API_TOKEN" \
  "$LEITWERK_URL/api/auth/me"
```

## Replace or revoke a token

To replace a token, create a new one, update the tool that uses it, and verify a request succeeds. Then choose **Revoke** next to the old token.

To revoke every active token you own, use **Revoke all tokens**, then **Confirm revoke all**. Revocation takes effect immediately. Work already accepted and schedules already saved still run.

Tokens remain active when you log out. For details on token policy and the management API, see [Security](../admin/security.md).
