# get-youtube-transcript-with-headless-browser-mcp

This is an MCP server which grabs transcripts/subtitles as well as the title from YouTube videos using a **headless browser (Playwright)**.

If you've been using solutions based on yt-dlp and it has been giving you a lot of 429 (too many requests) error especially on auto-generated subtitles, this is something you can try.

While this version should be less vulnerable to 429 errors, if youtube changes the HTML structure on the video page, that is not going to be fixed by simply updating yt-dlp. So it is more brittle in that way, but that probably does not happen too often, hopefully.

Like my [yt-dlp version](https://github.com/Mizstik/get-youtube-video-transcript-mcp), this MCP can operate in both stdio and http-streamable based on how it is invoked or added to the frontend.

# Installation
```
git clone https://github.com/Mizstik/get-youtube-transcript-with-headless-browser-mcp.git
cd get-youtube-transcript-with-headless-browser-mcp
npm install
```

Unlike the yt-dlp version, this MCP does not require ffmpeg, and also does not have the initialize/update tools.

The setup guide for adding MCPs to frontend is included later in this readme (mostly copied from my other MCP) but first I will mention details that are more pertinent to the headless browser version of this MCP.

# Browser Persistence & Login

This MCP can be used without any login and should be able to download subtitles and comments without credentials. However, the internal browser will keep a persistent session & profile in the MCP's folder.

In the first time you use this tool after installing (before it has built up any session & profile info), it may be slow at loading youtube or may timeout completely as youtube tries to verify that it's not a bot. Keep trying on different videos and it should succeed after a few tries, and thereafter it should have no problem operating.

However, if it never succeeds (or later down the line it fails with increasing frequency), you can try invoking the "login" tool by telling your AI agent:

```
Invoke login-youtube-browser on the youtube MCP.
```

This will open a visible (i.e., NOT headless) instance of Chrome that utilizes the MCP's session profile. (The frontend may also prompt you for permission.) With this chrome window, navigate to youtube, clear any CAPTCHA, open a few videos, etc. then close it. This should be sufficient to help the tool operate successfully subsequently.

And finally, if you need to, you can use this window to login to youtube (with your Google credentials) in this window, and it will save that login to the persistent profile in the MCP. This should really help it pass any anti-bot checks thereafter.

It should be noted that, if you do this, you need to keep the MCP's folder (and the machine it runs on) secure from any unauthorized access. Anyone who gains access to that persistent session info folder will gain access to your account.

Below here are info copied from my other youtube transcript MCP that this was based on.

## Command-line options

| Option | Default | Description |
|--------|---------|-------------|
| `--http` | (stdio) | Enable HTTP streamable transport mode |
| `--port=N` | `12001` | Port to listen on (only in HTTP mode) |
| `--chunk-size=N` | `15360` (~15 KB) | Max bytes per stdio chunk. Accepts suffixes: `KB`, `MB` (e.g. `--chunk-size=25KB`) |
| `--profile=PATH` | `.browser-profile` | Persistent browser profile directory (cookies/login are kept here) |

## stdio transport
Some desktop frontends, like LM Studio, prefer MCPs with stdio transport. To add this MCP to the frontend, add the following to the MCP config file. (In LMS, this is "Edit mcp.json" in the Integration sidebar, in the Install button.)

    "get-youtube-transcript-with-headless-browser-mcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\get-youtube-transcript-with-headless-browser-mcp\\main.js"
      ]
    }

When main.js is executed with no command line arguments, it will operate in stdio mode. The LLM frontend will execute this for you automatically when needed and there is no resident process or server running.

### Chunking
In many frontends (including LM Studio and Hermes), if the response from MCP in stdio mode is too large, the frontend will arbitrarily cut off and put "truncated" at the end. This tends to happen at around 30 KB (or about 20-30 minutes of video depending on how fast the host speaks). To circumvent this, the MCP will chunk subtitles at the configured size (default ~15 KB, adjustable via `--chunk-size`). The agent will need to call the MCP again to obtain the rest. To do this, you may need to provide instructions to the agent either in the prompt, the context, or the skill. For example:

```
If the transcript starts with "Part 1/3" or similar, it means there are more transcript to fetch., in which case call the tool again with chunk: 2, or chunk: 3 or more as needed to fetch the rest of the subtitles until all parts are obtained.
```
As far as I know, this truncation does not happen when agents call the MCP in HTTP streamable mode (at least not with OpenWebUI and Hermes) and the agent can obtain the entire transcript in one call no matter how large it is.

## streamable http
Some frontends, particularly server-based ones such as OpenWebUI, prefer MCPs with streamable http transport.

First, start the MCP http server with the --http argument. Port can be omitted which will default to 12002.
```
node main.js --http --port=12002

MCP server listening on port 12002
```
This will start the server and it's intended to be kept running indefinitely, in order to listen and respond to frontend requests. Do not close the terminal or command line box where this is running.

On the frontend, add the integration with a URL to the machine where the MCP is running, making sure to add the http:// prefix and append the port and the /mcp path. Example:
```
http://192.168.8.120:12002/mcp
```

### Note for OpenWebUI
You will need to add this in the *Admin Panel*. Adding the mcp in user options will fail silently, as of OWUI 0.9.

Be sure to change the "Type" at the top from OpenAPI to MCP Streamable HTTP. Change the auth to None.
