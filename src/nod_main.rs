mod nod;

#[tokio::main]
async fn main() {
    if let Err(error) = nod::run_stdio().await {
        eprintln!("fennec-nod: {error}");
        std::process::exit(1);
    }
}
