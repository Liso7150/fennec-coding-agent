mod antigravity;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let provider = antigravity::AntigravityConfig::from_env();
    if args.first().is_some_and(|arg| arg == "status") {
        println!("{}", provider.status());
        return;
    }
    let goal = if args.is_empty() {
        eprintln!("usage: fennec-antigravity status | <goal>");
        std::process::exit(2);
    } else {
        args.join(" ")
    };
    match provider.run(&goal).await {
        Ok(answer) => println!("{answer}"),
        Err(error) => {
            eprintln!("fennec-antigravity: {error}");
            std::process::exit(1);
        }
    }
}
