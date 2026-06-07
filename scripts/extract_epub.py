import html
import json
import posixpath
import re
import sys
import zipfile
from html.parser import HTMLParser
from pathlib import PurePosixPath
from xml.etree import ElementTree


NS = {
    "container": "urn:oasis:names:tc:opendocument:xmlns:container",
    "opf": "http://www.idpf.org/2007/opf",
    "dc": "http://purl.org/dc/elements/1.1/",
}


class TextExtractor(HTMLParser):
    BLOCK_TAGS = {
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "main",
        "nav",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tr",
        "ul",
    }

    SKIP_TAGS = {"script", "style", "svg", "math"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.skip_depth = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
        if self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.SKIP_TAGS and self.skip_depth:
            self.skip_depth -= 1
        if self.skip_depth == 0 and tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip_depth == 0:
            self.parts.append(data)

    def text(self):
        value = html.unescape("".join(self.parts))
        value = re.sub(r"[ \t\f\v]+", " ", value)
        value = re.sub(r" *\n *", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()


class HeadingExtractor(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.current = None
        self.values = {"title": [], "h1": [], "h2": []}

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        if tag in self.values:
            self.current = tag

    def handle_endtag(self, tag):
        if self.current == tag.lower():
            self.current = None

    def handle_data(self, data):
        if self.current:
            self.values[self.current].append(data)

    def title(self):
        for key in ("title", "h1", "h2"):
            value = clean_text(" ".join(self.values[key]))
            if value:
                return value
        return None


def clean_text(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"-\n(?=\w)", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def xml_text(root, path):
    node = root.find(path, NS)
    return node.text.strip() if node is not None and node.text else None


def read_zip_text(epub, name):
    data = epub.read(name)
    for encoding in ("utf-8", "utf-16", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def resolve_member(base_file, href):
    base_dir = str(PurePosixPath(base_file).parent)
    if base_dir == ".":
        base_dir = ""
    href = href.split("#", 1)[0]
    return posixpath.normpath(posixpath.join(base_dir, href))


def extract(epub_path):
    with zipfile.ZipFile(epub_path) as epub:
        container_xml = read_zip_text(epub, "META-INF/container.xml")
        container = ElementTree.fromstring(container_xml)
        rootfile = container.find(".//container:rootfile", NS)
        if rootfile is None:
            raise RuntimeError("EPUB has no rootfile entry")

        opf_path = rootfile.attrib["full-path"]
        opf_xml = read_zip_text(epub, opf_path)
        opf = ElementTree.fromstring(opf_xml)

        title = xml_text(opf, ".//dc:title")
        author = xml_text(opf, ".//dc:creator")

        manifest = {}
        for item in opf.findall(".//opf:manifest/opf:item", NS):
            item_id = item.attrib.get("id")
            href = item.attrib.get("href")
            if item_id and href:
                manifest[item_id] = resolve_member(opf_path, href)

        chapters = []
        for itemref in opf.findall(".//opf:spine/opf:itemref", NS):
            item_id = itemref.attrib.get("idref")
            member = manifest.get(item_id or "")
            if not member:
                continue
            if not member.lower().endswith((".xhtml", ".html", ".htm")):
                continue
            try:
                chapter_html = read_zip_text(epub, member)
            except KeyError:
                continue

            parser = TextExtractor()
            parser.feed(chapter_html)
            text = parser.text()
            if text:
                heading_parser = HeadingExtractor()
                heading_parser.feed(chapter_html)
                chapters.append(
                    {
                        "index": len(chapters),
                        "title": heading_parser.title() or f"Chapter {len(chapters) + 1}",
                        "href": member,
                        "text": text,
                    }
                )

        full_text = clean_text("\n\n".join(chapter["text"] for chapter in chapters))
        warning = None if full_text else "No readable XHTML text was found in this EPUB."
        return {"title": title, "author": author, "text": full_text, "chapters": chapters, "warning": warning}


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: extract_epub.py <book.epub>")
    payload = json.dumps(extract(sys.argv[1]), ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(payload)


if __name__ == "__main__":
    main()
