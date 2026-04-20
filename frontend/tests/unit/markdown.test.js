/**
 * @fileoverview Unit tests for the lightweight markdown renderer.
 * Tests covering inline formatting, links, lists, XSS prevention,
 * URL sanitisation, and HTML sanitisation for PeeringDB notes fields.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../../js/markdown.js';

describe("renderMarkdown", () => {
    it("should return empty string for null/undefined/empty input", () => {
        assert.equal(renderMarkdown(null), '');
        assert.equal(renderMarkdown(undefined), '');
        assert.equal(renderMarkdown(''), '');
    });

    it("should render bold text (**text**)", () => {
        const result = renderMarkdown("This is **bold** text");
        assert.ok(result.includes('<strong>bold</strong>'));
    });

    it("should render bold text (__text__)", () => {
        const result = renderMarkdown("This is __bold__ text");
        assert.ok(result.includes('<strong>bold</strong>'));
    });

    it("should render italic text (*text*)", () => {
        const result = renderMarkdown("This is *italic* text");
        assert.ok(result.includes('<em>italic</em>'));
    });

    it("should render code spans (`code`)", () => {
        const result = renderMarkdown("Use `SELECT *` here");
        assert.ok(result.includes('<code>SELECT *</code>'));
    });

    it("should render markdown links", () => {
        const result = renderMarkdown("[PeeringDB](https://www.peeringdb.com)");
        assert.ok(result.includes('href="https://www.peeringdb.com"'));
        assert.ok(result.includes('PeeringDB'));
        assert.ok(result.includes('target="_blank"'));
    });

    it("should render bare URLs as links", () => {
        const result = renderMarkdown("Visit https://example.com today");
        assert.ok(result.includes('href="https://example.com"'));
    });

    it("should render unordered lists", () => {
        const result = renderMarkdown("- item one\n- item two");
        assert.ok(result.includes('<ul>'));
        assert.ok(result.includes('<li>item one</li>'));
        assert.ok(result.includes('<li>item two</li>'));
        assert.ok(result.includes('</ul>'));
    });

    it("should escape HTML tags to prevent XSS", () => {
        const result = renderMarkdown("<script>alert('xss')</script>");
        assert.ok(!result.includes('<script>'));
        assert.ok(result.includes('alert'));
    });

    it("should reject javascript: URLs", () => {
        const result = renderMarkdown("[click](javascript:alert(1))");
        assert.ok(!result.includes('javascript:'));
        assert.ok(!result.includes('href'));
    });

    it("should allow mailto: URLs", () => {
        const result = renderMarkdown("[email](mailto:user@example.com)");
        assert.ok(result.includes('href="mailto:user@example.com"'));
    });

    it("should handle line breaks", () => {
        const result = renderMarkdown("line one\nline two");
        assert.ok(result.includes('<br>'));
    });
});

describe("renderMarkdown — HTML sanitisation", () => {
    it("should render <a href> tags as clickable links", () => {
        const input = '<a href="https://www.cloudflare.com">Cloudflare</a>';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="https://www.cloudflare.com"'));
        assert.ok(result.includes('>Cloudflare</a>'));
    });

    it("should force target and rel on anchor tags", () => {
        const input = '<a href="https://example.com">link</a>';
        const result = renderMarkdown(input);
        assert.ok(result.includes('target="_blank"'), 'should have target="_blank"');
        assert.ok(result.includes('rel="noopener noreferrer"'), 'should have rel="noopener noreferrer"');
    });

    it("should strip target, rel, class, and other attributes from anchors", () => {
        const input = '<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="fancy">text</a>';
        const result = renderMarkdown(input);
        // Should have the link with forced attributes
        assert.ok(result.includes('href="https://example.com"'));
        assert.ok(result.includes('>text</a>'));
        // Should NOT leak attribute text like target="_blank" as visible content
        assert.ok(!result.includes('class='));
        assert.ok(!result.includes('fancy'));
        // Count occurrences of target="_blank" — should appear once (in our harness)
        const targets = result.match(/target="_blank"/g) || [];
        assert.equal(targets.length, 1, 'target="_blank" should appear exactly once');
    });

    it("should not leak escaped attribute text as visible content", () => {
        // This is the actual bug from the review: the original code would show
        // target=&quot;_blank&quot; as visible text
        const input = '<a href="https://www.cloudflare.com" target="_blank" rel="noopener noreferrer">Cloudflare Website</a>';
        const result = renderMarkdown(input);
        assert.ok(!result.includes('&quot;'), 'should not contain &quot; as visible text');
        // Strip all HTML tags to get visible text only
        const visibleText = result.replace(/<[^>]+>/g, '');
        assert.ok(!visibleText.includes('_blank'), 'visible text should not contain _blank');
        assert.ok(!visibleText.includes('noopener'), 'visible text should not contain noopener');
        // The actual content should be the link
        assert.ok(result.includes('>Cloudflare Website</a>'));
    });

    it("should strip anchors with javascript: URLs", () => {
        const input = '<a href="javascript:alert(1)">evil</a>';
        const result = renderMarkdown(input);
        assert.ok(!result.includes('javascript:'));
        assert.ok(!result.includes('href'));
        assert.ok(result.includes('evil'), 'text content should be preserved');
    });

    it("should strip anchors with no href", () => {
        const input = '<a name="anchor">text</a>';
        const result = renderMarkdown(input);
        assert.ok(!result.includes('<a '));
        assert.ok(result.includes('text'));
    });

    it("should preserve safe HTML tags", () => {
        const input = 'This is <strong>bold</strong> and <em>italic</em>';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<strong>bold</strong>'));
        assert.ok(result.includes('<em>italic</em>'));
    });

    it("should strip unsafe HTML tags but keep content", () => {
        const input = '<div class="container"><span style="color:red">text</span></div>';
        const result = renderMarkdown(input);
        assert.ok(!result.includes('<div'));
        assert.ok(!result.includes('<span'));
        assert.ok(!result.includes('style='));
        assert.ok(result.includes('text'));
    });

    it("should handle mixed HTML and markdown", () => {
        const input = '**Bold** and <a href="https://example.com">HTML link</a> and [md link](https://other.com)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<strong>Bold</strong>'));
        assert.ok(result.includes('href="https://example.com"'));
        assert.ok(result.includes('>HTML link</a>'));
        assert.ok(result.includes('href="https://other.com"'));
        assert.ok(result.includes('>md link</a>'));
    });

    it("should handle anchor tags with single-quoted hrefs", () => {
        const input = "<a href='https://example.com'>link</a>";
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="https://example.com"'));
    });

    it("should handle <br> tags", () => {
        const input = 'line one<br>line two';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<br>'));
        assert.ok(result.includes('line one'));
        assert.ok(result.includes('line two'));
    });

    it("should handle self-closing <br /> tags", () => {
        const input = 'line one<br />line two';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<br>'));
    });
});

describe("renderMarkdown — headings", () => {
    it("should render # as h1", () => {
        const result = renderMarkdown("# Main Title");
        assert.ok(result.includes('<h1>Main Title</h1>'));
    });

    it("should render ## as h2", () => {
        const result = renderMarkdown("## Section");
        assert.ok(result.includes('<h2>Section</h2>'));
    });

    it("should render ### as h3", () => {
        const result = renderMarkdown("### Subsection");
        assert.ok(result.includes('<h3>Subsection</h3>'));
    });

    it("should render h4 through h6", () => {
        assert.ok(renderMarkdown("#### H4").includes('<h4>H4</h4>'));
        assert.ok(renderMarkdown("##### H5").includes('<h5>H5</h5>'));
        assert.ok(renderMarkdown("###### H6").includes('<h6>H6</h6>'));
    });

    it("should not treat # without a space as a heading", () => {
        const result = renderMarkdown("#nospace");
        assert.ok(!result.includes('<h1>'));
        assert.ok(result.includes('#nospace'));
    });

    it("should handle inline formatting inside headings", () => {
        const result = renderMarkdown("## **Bold** heading");
        assert.ok(result.includes('<h2>'));
        assert.ok(result.includes('<strong>Bold</strong>'));
    });
});

describe("renderMarkdown — fenced code blocks", () => {
    it("should render ``` fenced blocks as <pre><code>", () => {
        const input = '```\ncurl -H "Auth: key" https://api.example.com\n```';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<pre><code>'));
        assert.ok(result.includes('</code></pre>'));
        assert.ok(result.includes('curl'));
    });

    it("should preserve whitespace inside code blocks", () => {
        const input = '```\n  indented\n    more\n```';
        const result = renderMarkdown(input);
        assert.ok(result.includes('  indented'));
        assert.ok(result.includes('    more'));
    });

    it("should not apply inline formatting inside code blocks", () => {
        const input = '```\n**not bold** and *not italic*\n```';
        const result = renderMarkdown(input);
        // The bold/italic markers should be escaped but not turned into tags
        // inside our already-escaped code block
        assert.ok(!result.includes('<strong>'));
        assert.ok(!result.includes('<em>'));
    });

    it("should handle unclosed code blocks", () => {
        const input = '```\nsome code without closing fence';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<pre><code>'));
        assert.ok(result.includes('some code'));
    });

    it("should handle code blocks with language hint", () => {
        const input = '```bash\necho hello\n```';
        const result = renderMarkdown(input);
        assert.ok(result.includes('<pre><code>'));
        assert.ok(result.includes('echo hello'));
    });

    it("should handle multiple code blocks", () => {
        const input = '```\nblock one\n```\n\nSome text\n\n```\nblock two\n```';
        const result = renderMarkdown(input);
        const preCount = (result.match(/<pre>/g) || []).length;
        assert.equal(preCount, 2, 'should have two code blocks');
    });
});

describe("renderMarkdown — PeeringDB link rewriting", () => {
    it("should rewrite www.peeringdb.com/net/ to local /net/", () => {
        const input = '[My Network](https://www.peeringdb.com/net/694)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="/net/694"'), `expected local href, got: ${result}`);
        assert.ok(result.includes('data-link'), 'should have data-link attribute');
        assert.ok(!result.includes('peeringdb.com'), 'should not contain peeringdb.com');
    });

    it("should rewrite peeringdb.com without www", () => {
        const input = '[IX](https://peeringdb.com/ix/42)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="/ix/42"'));
        assert.ok(result.includes('data-link'));
    });

    it("should rewrite facility links", () => {
        const input = '<a href="https://www.peeringdb.com/fac/123">Facility</a>';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="/fac/123"'));
        assert.ok(result.includes('data-link'));
    });

    it("should rewrite org, carrier, and campus links", () => {
        for (const type of ['org', 'carrier', 'campus']) {
            const input = `[Link](https://www.peeringdb.com/${type}/99)`;
            const result = renderMarkdown(input);
            assert.ok(result.includes(`href="/${type}/99"`), `${type} should be rewritten`);
        }
    });

    it("should preserve non-entity peeringdb.com links", () => {
        const input = '[API docs](https://www.peeringdb.com/apidocs/)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('peeringdb.com/apidocs'), 'non-entity link should be preserved');
    });

    it("should handle trailing slash on entity URLs", () => {
        const input = '[Net](https://www.peeringdb.com/net/694/)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="/net/694"'));
    });

    it("should handle http:// (non-https) links", () => {
        const input = '[Net](http://peeringdb.com/net/111)';
        const result = renderMarkdown(input);
        assert.ok(result.includes('href="/net/111"'));
    });
});
