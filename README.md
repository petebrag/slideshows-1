# Slideshow Machine

Agent-led creation of looping, self-contained HTML slideshows. Supply a file or pasted text, review the HTML preview, request revisions, then explicitly publish the approved deck for iPad viewing.

The browser player extends the existing tiny slideshow rather than adding a framework. It provides manual navigation, touch swipes, per-slide reading time, speed controls, looping, and best-effort screen wake lock. The HTML shell comes from the shared `html-doc` template.

Requires Python 3.10+, Git, pandoc and `pdftotext`. On the development Mac these tools are already installed. Run `python3 machine.py --help`; agent operation and publication boundaries are documented in [AGENTS.md](AGENTS.md).

Drafts and their local Git history stay in ignored `.local/`. Generated HTML has no runtime dependencies or external resource requests. Publishing requires GitHub CLI authentication and a specific request to publish publicly. Existing live files remain unchanged until that command runs.

Mac previews can open as files. iPad viewing uses a published HTTPS link. Actual iPad verification and offline viewing are separate from desktop browser checks.
