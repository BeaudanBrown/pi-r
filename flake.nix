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

          piResources = pkgs.runCommand "pi-r-resources-0.14.0" {
            nativeBuildInputs = [ pkgs.esbuild ];
          } ''
            mkdir -p $out/share/pi-r/extensions $out/share/pi-r/R $out/share/pi-r/resources $out/share/pi-r/skills/pi-r/references $out/share/pi-r/docs
            esbuild ${self}/extensions/pi-r.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --outfile=$out/share/pi-r/extensions/pi-r.ts
            esbuild ${self}/extensions/pi-r-dependency-scout.ts \
              --bundle \
              --platform=node \
              --format=esm \
              --outfile=$out/share/pi-r/extensions/pi-r-dependency-scout.ts
            cp ${./R/pi_r_runtime.R} $out/share/pi-r/R/pi_r_runtime.R
            cp ${./R/read_contract.R} $out/share/pi-r/R/read_contract.R
            cp ${./R/style_body.R} $out/share/pi-r/R/style_body.R
            cp ${./R/worker.R} $out/share/pi-r/R/worker.R
            cp ${./R/target_runner.R} $out/share/pi-r/R/target_runner.R
            cp ${./R/artifact_inspector.R} $out/share/pi-r/R/artifact_inspector.R
            cp ${./resources/r-functions.scm} $out/share/pi-r/resources/r-functions.scm
            cp ${./resources/project-contract.schema.json} $out/share/pi-r/resources/project-contract.schema.json
            cp ${./resources/technology-policy-v1.json} $out/share/pi-r/resources/technology-policy-v1.json
            cp ${./skills/pi-r/SKILL.md} $out/share/pi-r/skills/pi-r/SKILL.md
            cp ${./skills/pi-r/references/workbench.md} $out/share/pi-r/skills/pi-r/references/workbench.md
            cp ${self}/docs/*.md $out/share/pi-r/docs/
          '';

          rRuntime = pkgs.rWrapper.override {
            packages = with pkgs.rPackages; [ data_table jsonlite qs2 styler targets yaml ];
          };

          piR = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-r";
            version = "0.14.0";
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
                --prefix PATH : "${pkgs.lib.makeBinPath [ pkgs.bubblewrap pkgs.tree-sitter rRuntime ]}" \
                --set-default PI_R_RESOURCE_ROOT "${piResources}/share/pi-r" \
                --set-default PI_R_TREE_SITTER "${pkgs.tree-sitter}/bin/tree-sitter" \
                --set-default PI_R_TREE_SITTER_R "${pkgs.tree-sitter-grammars.tree-sitter-r}/parser" \
                --set-default PI_R_TREE_SITTER_QUERY "${piResources}/share/pi-r/resources/r-functions.scm" \
                --set-default PI_R_RSCRIPT "${rRuntime}/bin/Rscript" \
                --set-default PI_R_BASE_RSCRIPT "${rRuntime}/bin/Rscript" \
                --set-default PI_R_FORMATTER_SCRIPT "${piResources}/share/pi-r/R/style_body.R" \
                --set-default PI_R_CONTRACT_READER "${piResources}/share/pi-r/R/read_contract.R" \
                --set-default PI_R_BWRAP "${pkgs.bubblewrap}/bin/bwrap" \
                --set-default PI_R_WORKER_RSCRIPT "${rRuntime}/bin/Rscript" \
                --set-default PI_R_WORKER_SCRIPT "${piResources}/share/pi-r/R/worker.R" \
                --set-default PI_R_TARGET_RUNNER_SCRIPT "${piResources}/share/pi-r/R/target_runner.R" \
                --set-default PI_R_ARTIFACT_INSPECTOR_SCRIPT "${piResources}/share/pi-r/R/artifact_inspector.R"
              runHook postInstall
            '';

            passthru = {
              resourcePaths = {
                root = "${piResources}/share/pi-r";
                extension = "${piResources}/share/pi-r/extensions/pi-r.ts";
                scoutExtension = "${piResources}/share/pi-r/extensions/pi-r-dependency-scout.ts";
                skill = "${piResources}/share/pi-r/skills/pi-r/SKILL.md";
                reference = "${piResources}/share/pi-r/skills/pi-r/references/workbench.md";
                docs = "${piResources}/share/pi-r/docs";
                cli = "${piR}/bin/pi-r";
                nixpkgs = "${pkgs.path}";
                rscript = "${rRuntime}/bin/Rscript";
                formatter = "${piResources}/share/pi-r/R/style_body.R";
                parser = "${pkgs.tree-sitter}/bin/tree-sitter";
                parserGrammar = "${pkgs.tree-sitter-grammars.tree-sitter-r}/parser";
                parserQuery = "${piResources}/share/pi-r/resources/r-functions.scm";
                sandbox = "${pkgs.bubblewrap}/bin/bwrap";
                worker = "${piResources}/share/pi-r/R/worker.R";
                targetRunner = "${piResources}/share/pi-r/R/target_runner.R";
                artifactInspector = "${piResources}/share/pi-r/R/artifact_inspector.R";
                contractReader = "${piResources}/share/pi-r/R/read_contract.R";
                technologyPolicy = "${piResources}/share/pi-r/resources/technology-policy-v1.json";
              };
              piResources = {
                extensions = [ "${piResources}/share/pi-r/extensions/pi-r.ts" ];
                skills = [ "${piResources}/share/pi-r/skills/pi-r" ];
                references = [ "${piResources}/share/pi-r/skills/pi-r/references/workbench.md" ];
                runtimePackages = [ piR ];
              };
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
          rTestRuntime = pkgs.rWrapper.override {
            packages = with pkgs.rPackages; [ data_table jsonlite qs2 styler targets yaml ];
          };
        in {
          verify = pkgs.runCommand "pi-r-verification-0.14.0" {
            nativeBuildInputs = [ pkgs.bubblewrap pkgs.esbuild pkgs.git pkgs.nix pkgs.nodejs_22 pkgs.R ];
          } ''
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME" "$TMPDIR/extension"

            test -x ${piR.resourcePaths.cli}
            test -x ${piR.resourcePaths.rscript}
            test -x ${piR.resourcePaths.parser}
            test -x ${piR.resourcePaths.sandbox}
            test -f ${piR.resourcePaths.extension}
            test -f ${piR.resourcePaths.scoutExtension}
            test -f ${piR.resourcePaths.skill}
            test -f ${piR.resourcePaths.reference}
            test -f ${piR.resourcePaths.formatter}
            test -x ${piR.resourcePaths.parserGrammar}
            test -f ${piR.resourcePaths.parserQuery}
            test -f ${piR.resourcePaths.worker}
            test -f ${piR.resourcePaths.targetRunner}
            test -f ${piR.resourcePaths.artifactInspector}
            test -f ${piR.resourcePaths.contractReader}
            test -f ${piR.resourcePaths.technologyPolicy}
            grep -Fx 'name: pi-r' ${piR.resourcePaths.skill} >/dev/null

            legacy_format="$(printf 'r\144s')"
            checked_sources="${self}/R ${self}/src ${self}/tests ${self}/docs ${self}/extensions ${self}/resources ${self}/README.md"
            if grep -RIinw "$legacy_format" $checked_sources || grep -RInE "save$legacy_format|read$legacy_format" $checked_sources; then
              echo "legacy serialization usage is prohibited; use targets format=qs backed by qs2" >&2
              exit 1
            fi

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
            PI_R_SCOUT_EXTENSION=${resources}/share/pi-r/extensions/pi-r-dependency-scout.ts \
              node --test ${./tests/dependency-scout-extension.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_NIXPKGS_PATH=${pkgs.path} \
              PI_R_SHARED_POLICY_PATH="$TMPDIR/pi-r-shared-technology-policy.json" \
              PI_R_COMPILED_EXTENSION="$TMPDIR/extension/pi-r.mjs" \
              PI_R_SCOUT_EXTENSION=${resources}/share/pi-r/extensions/pi-r-dependency-scout.ts \
              PI_R_CONTRACT_FIXTURE=${./tests/fixtures/project-contract.yml} \
              PI_R_TREE_SITTER=${pkgs.tree-sitter}/bin/tree-sitter \
              PI_R_TREE_SITTER_R=${pkgs.tree-sitter-grammars.tree-sitter-r}/parser \
              PI_R_TREE_SITTER_QUERY=${resources}/share/pi-r/resources/r-functions.scm \
              PI_R_RSCRIPT=${rTestRuntime}/bin/Rscript \
              PI_R_BASE_RSCRIPT=${rTestRuntime}/bin/Rscript \
              PI_R_FORMATTER_SCRIPT=${resources}/share/pi-r/R/style_body.R \
              PI_R_BWRAP=${pkgs.bubblewrap}/bin/bwrap \
              PI_R_WORKER_RSCRIPT=${rTestRuntime}/bin/Rscript \
              PI_R_PROJECT_RSCRIPT=${rTestRuntime}/bin/Rscript \
              PI_R_WORKER_SCRIPT=${resources}/share/pi-r/R/worker.R \
              PI_R_TARGET_RUNNER_SCRIPT=${resources}/share/pi-r/R/target_runner.R \
              PI_R_ARTIFACT_INSPECTOR_SCRIPT=${resources}/share/pi-r/R/artifact_inspector.R \
              node --test ${./tests/workbench-extension.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_EDIT_FIXTURE=${./tests/fixtures/representative.R} \
              node --test ${./tests/scoped-edit-cli.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_CONTRACT_FIXTURE=${./tests/fixtures/project-contract.yml} \
              node --test ${./tests/contract-scaffold-cli.test.mjs}
            PI_R_CLI=${piR}/bin/pi-r \
              PI_R_CONTRACT_FIXTURE=${./tests/fixtures/project-contract.yml} \
              node --test ${./tests/environment-governance-cli.test.mjs}
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
