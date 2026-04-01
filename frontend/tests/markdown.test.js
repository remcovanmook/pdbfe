/**
 * @fileoverview Unit tests for the lightweight markdown renderer.
 * Tests covering inline formatting, links, lists, XSS prevention,
 * and URL sanitisation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../js/markdown.js';

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
        assert.ok(result.includes('&lt;script&gt;'));
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
