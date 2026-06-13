//! Render a ratatui [`Buffer`] to a standalone SVG. This lets us produce a
//! crisp, perfectly aligned screenshot of the dashboard for the README without
//! capturing a real terminal. Every cell becomes a positioned `<tspan>`, so the
//! output looks identical on GitHub, in browsers, and on any platform.

use ratatui::buffer::Buffer;
use ratatui::style::{Color, Modifier};

const CELL_W: f32 = 8.4;
const LINE_H: f32 = 18.0;
const PAD: f32 = 12.0;
const BG: &str = "#0d1117";
const DEFAULT_FG: &str = "#dedee8";

/// Serialize a rendered buffer to an SVG document string.
pub fn buffer_to_svg(buf: &Buffer) -> String {
    let area = buf.area;
    let width = area.width as f32 * CELL_W + PAD * 2.0;
    let height = area.height as f32 * LINE_H + PAD * 2.0;

    let mut svg = String::new();
    svg.push_str(&format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0}" height="{height:.0}" viewBox="0 0 {width:.0} {height:.0}" font-family="ui-monospace, 'Cascadia Code', 'JetBrains Mono', 'DejaVu Sans Mono', Menlo, Consolas, monospace" font-size="14">"#,
    ));
    svg.push_str(&format!(
        r#"<rect width="{width:.0}" height="{height:.0}" rx="10" fill="{BG}"/>"#,
    ));

    for y in 0..area.height {
        let baseline = PAD + y as f32 * LINE_H + LINE_H * 0.74;
        svg.push_str(&format!(r#"<text y="{baseline:.1}" xml:space="preserve">"#));

        let mut x = 0u16;
        while x < area.width {
            let cell = &buf.content[(y as usize) * area.width as usize + x as usize];
            let sym = cell.symbol();
            if sym == " " || sym.is_empty() {
                x += 1;
                continue;
            }

            let fg = color_hex(cell.fg);
            let bold = cell.modifier.contains(Modifier::BOLD);
            let italic = cell.modifier.contains(Modifier::ITALIC);
            let run_x = x;
            let mut text = String::new();

            while x < area.width {
                let c = &buf.content[(y as usize) * area.width as usize + x as usize];
                let cs = c.symbol();
                if cs == " " || cs.is_empty() {
                    break;
                }
                if color_hex(c.fg) != fg
                    || c.modifier.contains(Modifier::BOLD) != bold
                    || c.modifier.contains(Modifier::ITALIC) != italic
                {
                    break;
                }
                text.push_str(cs);
                x += 1;
            }

            let px = PAD + run_x as f32 * CELL_W;
            let weight = if bold { r#" font-weight="bold""# } else { "" };
            let style = if italic {
                r#" font-style="italic""#
            } else {
                ""
            };
            svg.push_str(&format!(
                r#"<tspan x="{px:.1}" fill="{fg}"{weight}{style}>{}</tspan>"#,
                xml_escape(&text)
            ));
        }
        svg.push_str("</text>");
    }

    svg.push_str("</svg>");
    svg
}

fn color_hex(c: Color) -> String {
    match c {
        Color::Rgb(r, g, b) => format!("#{r:02x}{g:02x}{b:02x}"),
        Color::White => "#ffffff".to_string(),
        Color::Black => "#000000".to_string(),
        Color::Green => "#7ed321".to_string(),
        Color::Red => "#ff5f6d".to_string(),
        Color::Yellow => "#f5c542".to_string(),
        Color::Cyan => "#5eead4".to_string(),
        _ => DEFAULT_FG.to_string(),
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
