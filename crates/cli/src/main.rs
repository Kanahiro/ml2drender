mod expression_tests;
mod pixelmatch;
mod render_tests;

use std::path::{Path, PathBuf};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = root.as_path();
    if !root.join("fixtures").exists() && args.first().is_some_and(|a| a.ends_with("-tests")) {
        eprintln!("fixtures/ missing: run scripts/fetch-fixtures.sh");
        std::process::exit(2);
    }
    let filter = args.get(1).map(String::as_str);
    match args.first().map(String::as_str) {
        Some("render-tests") => render_tests::run(root, filter),
        Some("expression-tests") => expression_tests::run(root, filter),
        Some("compare") if args.len() >= 3 => {
            let threshold = args.get(3).map_or(0.1285, |t| t.parse().unwrap());
            let diff = render_tests::compare(Path::new(&args[1]), Path::new(&args[2]), threshold);
            println!("{diff}");
        }
        _ => {
            eprintln!(
                "usage: ml2drender (render-tests | expression-tests) [id-substring-filter]\n       ml2drender compare <a.png> <b.png> [threshold]  # mismatched pixel count"
            );
            std::process::exit(2);
        }
    }
}

/// All files named `name` under `dir`, sorted.
fn find_files(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if e.file_name() == name {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn read_json(path: &Path) -> serde_json::Value {
    let s = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Exits with 1 if a test outside `tests/known-failures.json` failed, so CI catches regressions
/// while the known failures stay as they are.
fn check_known_failures(suite: &str, failed: &[String], passed: &[String]) {
    let known = read_json(&Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/known-failures.json"));
    let known: Vec<&str> = known[suite].as_array().into_iter().flatten().filter_map(|v| v.as_str()).collect();
    let fixed: Vec<&str> = passed.iter().map(String::as_str).filter(|id| known.contains(id)).collect();
    if !fixed.is_empty() {
        eprintln!("now passing, remove from tests/known-failures.json:\n  {}", fixed.join("\n  "));
    }
    let new: Vec<&str> = failed.iter().map(String::as_str).filter(|id| !known.contains(id)).collect();
    if !new.is_empty() {
        eprintln!("{} new {suite} test failure(s):\n  {}", new.len(), new.join("\n  "));
        std::process::exit(1);
    }
}

#[derive(Default)]
struct Tally {
    pass: usize,
    fail: usize,
    skip: usize,
}

impl Tally {
    fn add(&mut self, status: &str) {
        match status {
            "pass" => self.pass += 1,
            "fail" => self.fail += 1,
            _ => self.skip += 1,
        }
    }

    fn rate(&self) -> f64 {
        let run = self.pass + self.fail;
        if run == 0 { 0.0 } else { 100.0 * self.pass as f64 / run as f64 }
    }

    fn line(&self) -> String {
        format!(
            "total {} — pass {} / fail {} / skip {} — pass rate {:.1}% of {} in scope",
            self.pass + self.fail + self.skip,
            self.pass,
            self.fail,
            self.skip,
            self.rate(),
            self.pass + self.fail
        )
    }

    fn row(&self, label: &str) -> String {
        format!("| {label} | {} | {} | {} | {:.1}% |\n", self.pass, self.fail, self.skip, self.rate())
    }
}
