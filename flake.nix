{
  description = "Constrained, phase-gated R and targets workspace for Pi";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          piResources = pkgs.runCommand "pi-r-resources-0.5.0" {
            nativeBuildInputs = [ pkgs.esbuild ];
          } ''
            mkdir -p $out/share/pi-r/extensions $out/share/pi-r/R $out/share/pi-r/resources
            esbuild ${self}/extensions/pi-r.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --outfile=$out/share/pi-r/extensions/pi-r.ts
            cp ${./R/pi_r_runtime.R} $out/share/pi-r/R/pi_r_runtime.R
            cp ${./R/read_contract.R} $out/share/pi-r/R/read_contract.R
            cp ${./R/style_body.R} $out/share/pi-r/R/style_body.R
            cp ${./resources/r-functions.scm} $out/share/pi-r/resources/r-functions.scm
            cp ${./resources/project-contract.schema.json} $out/share/pi-r/resources/project-contract.schema.json
          '';

          rRuntime = pkgs.rWrapper.override {
            packages = [ pkgs.rPackages.jsonlite pkgs.rPackages.styler pkgs.rPackages.yaml ];
          };

          piR = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-r";
            version = "0.5.0";
            src = self;
            nativeBuildInputs = [ pkgs.esbuild pkgs.makeWrapper ];

            buildPhase = ''
              runHook preBuild
              esbuild src/index.ts src/cli.ts \
                --bundle \
                --platform=node \
                --format=esm \
                --outdir=dist \
                --out-extension:.js=.mjs
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              mkdir -p $out/lib/pi-r $out/bin $out/share
              cp dist/cli.mjs dist/index.mjs $out/lib/pi-r/
              ln -s ${piResources}/share/pi-r $out/share/pi-r
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pi-r \
                --add-flags "$out/lib/pi-r/cli.mjs" \
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.tree-sitter rRuntime ]}" \
                --set-default PI_R_RESOURCE_ROOT "${piResources}/share/pi-r" \
                --set-default PI_R_TREE_SITTER "${pkgs.tree-sitter}/bin/tree-sitter" \
                --set-default PI_R_TREE_SITTER_R "${pkgs.tree-sitter-grammars.tree-sitter-r}/parser" \
                --set-default PI_R_TREE_SITTER_QUERY "${piResources}/share/pi-r/resources/r-functions.scm" \
                --set-default PI_R_RSCRIPT "${rRuntime}/bin/Rscript" \
                --set-default PI_R_BASE_RSCRIPT "${rRuntime}/bin/Rscript" \
                --set-default PI_R_FORMATTER_SCRIPT "${piResources}/share/pi-r/R/style_body.R" \
                --set-default PI_R_CONTRACT_READER "${piResources}/share/pi-r/R/read_contract.R"
              runHook postInstall
            '';

            passthru.resourcePaths = {
              resources = "${piResources}/share/pi-r";
              extension = "${piResources}/share/pi-r/extensions/pi-r.ts";
              rHelper = "${piResources}/share/pi-r/R/pi_r_runtime.R";
            };

            meta = {
              description = "CLI for the constrained pi-r workbench";
              license = pkgs.lib.licenses.mit;
              mainProgram = "pi-r";
              platforms = systems;
            };
          };
        in {
          default = piR;
          pi-r = piR;
          pi-resources = piResources;
        });

      checks = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          piR = self.packages.${system}.pi-r;
          resources = self.packages.${system}.pi-resources;
        in {
          verify = pkgs.runCommand "pi-r-verification-0.5.0" {
            nativeBuildInputs = [ pkgs.esbuild pkgs.git pkgs.nix pkgs.nodejs_22 pkgs.R ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME" "$TMPDIR/extension"

            esbuild ${resources}/share/pi-r/extensions/pi-r.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --outfile="$TMPDIR/extension/pi-r.mjs"

            PI_R_CLI=${piR}/bin/pi-r \
              node --test ${./tests/cli-smoke.test.mjs}
            PI_R_LIBRARY=${piR}/lib/pi-r/index.mjs \
              node --test ${./tests/library-smoke.test.mjs}
            PI_R_COMPILED_EXTENSION="$TMPDIR/extension/pi-r.mjs" \
              node --test ${./tests/extension-smoke.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_COMPILED_EXTENSION="$TMPDIR/extension/pi-r.mjs" \
              PI_R_CONTRACT_FIXTURE=${./tests/fixtures/project-contract.yml} \
              node --test ${./tests/workbench-extension.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_EDIT_FIXTURE=${./tests/fixtures/representative.R} \
              node --test ${./tests/scoped-edit-cli.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_CONTRACT_FIXTURE=${./tests/fixtures/project-contract.yml} \
              node --test ${./tests/contract-scaffold-cli.test.mjs}
            PI_R_HELPER=${resources}/share/pi-r/R/pi_r_runtime.R \
              Rscript --vanilla ${./tests/runtime-smoke.R}

            mkdir -p $out/bin
            cat > $out/bin/pi-r-verify <<'EOF'
            #!${pkgs.runtimeShell}
            echo "pi-r verification passed"
            EOF
            chmod +x $out/bin/pi-r-verify
          '';
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.pi-r}/bin/pi-r";
          meta.description = "Run the pi-r CLI";
        };
        verify = {
          type = "app";
          program = "${self.checks.${system}.verify}/bin/pi-r-verify";
          meta.description = "Run the canonical deterministic verification gate";
        };
      });

      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.esbuild
              pkgs.git
              pkgs.nodejs_22
              pkgs.typescript
              pkgs.R
            ];
            shellHook = ''
              echo "pi-r development shell; verify with: nix run .#verify"
            '';
          };
        });
    };
}
